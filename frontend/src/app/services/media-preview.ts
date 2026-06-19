import { Injectable, signal } from '@angular/core';

export interface MediaPreviewItem {
  id: string;
  type: 'image' | 'audio';
  blobUrl: string;
  file: File | Blob;
  name: string;
  isAnalyzing?: boolean;
  isAnalyzed?: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class MediaPreviewService {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  
  isRecording = signal(false);

  createImagePreview(file: File): MediaPreviewItem {
    const blobUrl = URL.createObjectURL(file);
    return {
      id: 'img_' + Math.random().toString(36).substring(2, 9),
      type: 'image',
      blobUrl,
      file,
      name: file.name
    };
  }

  async startRecording(): Promise<void> {
    if (this.isRecording()) return;
    
    this.audioChunks = [];
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    let options = {};
    if (MediaRecorder.isTypeSupported('audio/webm')) {
      options = { mimeType: 'audio/webm' };
    } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
      options = { mimeType: 'audio/ogg' };
    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
      options = { mimeType: 'audio/mp4' };
    }
    
    const recorder = new MediaRecorder(stream, options);
    this.mediaRecorder = recorder;
    
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };

    recorder.start(10);
    this.isRecording.set(true);
  }

  stopRecording(): Promise<MediaPreviewItem> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder || !this.isRecording()) {
        reject(new Error('No active recording in progress'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        this.isRecording.set(false);
        
        if (this.mediaRecorder?.stream) {
          this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }

        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
        const audioBlob = new Blob(this.audioChunks, { type: mimeType });
        const blobUrl = URL.createObjectURL(audioBlob);
        const id = 'aud_' + Math.random().toString(36).substring(2, 9);
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const name = `Voice_${timestamp}`;
        
        resolve({
          id,
          type: 'audio',
          blobUrl,
          file: audioBlob,
          name
        });
      };

      this.mediaRecorder.stop();
    });
  }
}
