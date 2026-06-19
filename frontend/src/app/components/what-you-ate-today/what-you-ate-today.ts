import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService, User } from '../../services/auth';
import { MediaPreviewService, MediaPreviewItem } from '../../services/media-preview';
import { ModalComponent } from '../../utilities/components/modal/modal';
import { NavigationComponent } from '../navigation/navigation';

interface MealBreakdown {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  grade: string;
  tips: string[];
}

@Component({
  selector: 'app-what-you-ate-today',
  standalone: true,
  imports: [FormsModule, ModalComponent, NavigationComponent],
  templateUrl: './what-you-ate-today.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './what-you-ate-today.scss',
})
export class WhatYouAteTodayComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly mediaPreviewService = inject(MediaPreviewService);

  userName = signal('Member');
  userEmail = signal('');
  userBio = signal('');

  // Preview States
  previewItems = signal<MediaPreviewItem[]>([]);
  isRecording = this.mediaPreviewService.isRecording;

  hasUnanalyzedImages = computed(() => {
    return this.previewItems().some((i) => i.type === 'image' && !i.isAnalyzed);
  });

  hasUnanalyzedAudio = computed(() => {
    return this.previewItems().some((i) => i.type === 'audio' && !i.isAnalyzed);
  });

  currentScanningItem = signal<MediaPreviewItem | null>(null);
  private isQueueProcessing = false;
  private analysisQueue: MediaPreviewItem[] = [];
  private audioQueue: MediaPreviewItem[] = [];

  // Interactive Dashboard States
  foodInput = signal('');
  isLogModalOpen = signal(false);
  isSuccessModalOpen = signal(false);
  isAudioTranscribing = signal(false);
  logDateTime = signal('');
  isAnalyzing = signal(false);
  showResult = signal(false);
  mealBreakdown = signal<MealBreakdown | null>(null);

  // Image Classification States
  isImageAnalyzing = signal(false);
  detectedFood = signal('');
  detectionConfidence = signal(0);
  showConfirmationDialog = signal(false);
  nonFoodWarning = signal(false);
  selectedImageName = signal('');

  // Modal and Media Capture States
  isImageOptionModalOpen = signal(false);
  isVoiceOptionModalOpen = signal(false);
  imageMode = signal<'select' | 'camera'>('select');
  voiceMode = signal<'select' | 'recording'>('select');
  cameraError = signal<string | null>(null);
  voiceError = signal<string | null>(null);

  // Add More Details States
  isDetailsModalOpen = signal(false);
  additionalDetailsInput = signal('');
  detailsPlaceholderText = signal('');
  isUpdatingDetails = signal(false);

  @ViewChild('cameraVideo', { static: false }) cameraVideoRef?: ElementRef<HTMLVideoElement>;
  private cameraStream: MediaStream | null = null;

  ngOnInit(): void {
    const userid = this.authService.getUserId();
    if (userid) {
      this.authService.getUserDetails(userid).subscribe({
        next: (user) => {
          this.userName.set(user.name || 'Member');
          this.userEmail.set(user.email);
          this.userBio.set(user.userdetails || 'No profile details available.');
        },
        error: () => {
          // If fetch fails, we still show the page with default name
        },
      });
    }
  }

  openDetailsModal(): void {
    this.additionalDetailsInput.set('');
    this.isDetailsModalOpen.set(true);
    
    // Fetch the current placeholder dynamically from backend
    const userid = this.authService.getUserId();
    if (userid) {
      this.authService.updateDetails(userid, '').subscribe({
        next: (res) => {
          this.detailsPlaceholderText.set(res.placeholder || 'Could you share your age, height, or weight?');
        },
        error: () => {
          this.detailsPlaceholderText.set('Could you share your age, height, or weight?');
        }
      });
    }
  }

  submitAdditionalDetails(): void {
    const userid = this.authService.getUserId();
    const text = this.additionalDetailsInput().trim();
    if (!userid || !text) return;

    this.isUpdatingDetails.set(true);
    this.authService.updateDetails(userid, text).subscribe({
      next: (res) => {
        this.isUpdatingDetails.set(false);
        this.userBio.set(res.userdetails || 'No profile details available.');
        this.detailsPlaceholderText.set(res.placeholder || 'Any other details you want to share?');
        this.additionalDetailsInput.set('');
        this.isDetailsModalOpen.set(false);
      },
      error: (err) => {
        this.isUpdatingDetails.set(false);
        console.error('Failed to update details:', err);
      }
    });
  }

  onAnalyzeFood(): void {
    const untranscribedAudio = this.previewItems().filter(
      (i) => i.type === 'audio' && !i.isAnalyzed,
    );
    if (untranscribedAudio.length > 0) {
      this.isQueueProcessing = true;
      this.audioQueue = [...untranscribedAudio];
      this.processNextAudioQueueItem();
    } else {
      const unanalyzedImages = this.previewItems().filter(
        (i) => i.type === 'image' && !i.isAnalyzed,
      );
      if (unanalyzedImages.length > 0) {
        this.isQueueProcessing = true;
        this.analysisQueue = [...unanalyzedImages];
        this.processNextQueueItem();
      } else {
        this.isQueueProcessing = false;
        this.runFinalFoodAnalysis();
      }
    }
  }

  runFinalFoodAnalysis(): void {
    if (!this.foodInput().trim()) return;

    this.isAnalyzing.set(true);
    this.showResult.set(false);

    this.authService.analyzeFood(this.foodInput()).subscribe({
      next: (res) => {
        const breakdown: MealBreakdown = {
          calories: res.calories,
          protein: res.protein,
          carbs: res.carbs,
          fat: res.fat,
          grade: res.grade,
          tips: res.tips,
        };
        this.mealBreakdown.set(breakdown);
        this.isAnalyzing.set(false);
        this.showResult.set(true);
      },
      error: (err) => {
        this.isAnalyzing.set(false);
        console.error('Nutrition analysis failed:', err);
      },
    });
  }

  processNextQueueItem(): void {
    if (this.analysisQueue.length === 0) {
      if (this.isQueueProcessing) {
        this.isQueueProcessing = false;
        if (this.foodInput().trim()) {
          this.runFinalFoodAnalysis();
        }
      }
      return;
    }

    const nextItem = this.analysisQueue.shift();
    if (!nextItem) {
      this.processNextQueueItem();
      return;
    }

    this.currentScanningItem.set(nextItem);
    this.previewItems.update((items) =>
      items.map((i) => (i.id === nextItem.id ? { ...i, isAnalyzing: true } : i)),
    );

    this.isImageAnalyzing.set(true);
    this.showConfirmationDialog.set(false);
    this.nonFoodWarning.set(false);
    this.selectedImageName.set(nextItem.name);

    this.authService.analyzeImage(nextItem.file as File).subscribe({
      next: (res) => {
        this.isImageAnalyzing.set(false);
        this.previewItems.update((items) =>
          items.map((i) => (i.id === nextItem.id ? { ...i, isAnalyzing: false } : i)),
        );
        this.detectedFood.set(res.food_name);
        this.detectionConfidence.set(res.confidence);
        this.nonFoodWarning.set(!res.is_food);
        this.showConfirmationDialog.set(true);
      },
      error: (err) => {
        this.isImageAnalyzing.set(false);
        this.previewItems.update((items) =>
          items.map((i) => (i.id === nextItem.id ? { ...i, isAnalyzing: false } : i)),
        );
        this.selectedImageName.set('');
        this.currentScanningItem.set(null);
        console.error('Queue image analysis failed:', err);
        this.processNextQueueItem();
      },
    });
  }

  processNextAudioQueueItem(): void {
    if (this.audioQueue.length === 0) {
      const unanalyzedImages = this.previewItems().filter(
        (i) => i.type === 'image' && !i.isAnalyzed,
      );
      if (unanalyzedImages.length > 0) {
        this.analysisQueue = [...unanalyzedImages];
        this.processNextQueueItem();
      } else {
        this.isQueueProcessing = false;
        if (this.foodInput().trim()) {
          this.runFinalFoodAnalysis();
        }
      }
      return;
    }

    const nextAudio = this.audioQueue.shift();
    if (!nextAudio) {
      this.processNextAudioQueueItem();
      return;
    }

    this.previewItems.update((items) =>
      items.map((i) => (i.id === nextAudio.id ? { ...i, isAnalyzing: true } : i)),
    );
    this.isAudioTranscribing.set(true);

    this.authService.transcribeAudio(nextAudio.file).subscribe({
      next: (res) => {
        const transcribedText = res.text.trim();
        if (transcribedText) {
          const currentInput = this.foodInput().trim();
          if (currentInput) {
            this.foodInput.set(`${currentInput}, ${transcribedText}`);
          } else {
            this.foodInput.set(transcribedText);
          }
        }

        this.previewItems.update((items) =>
          items.map((i) =>
            i.id === nextAudio.id ? { ...i, isAnalyzing: false, isAnalyzed: true } : i,
          ),
        );
        this.isAudioTranscribing.set(false);
        this.processNextAudioQueueItem();
      },
      error: (err) => {
        console.error('Audio queue transcription failed:', err);
        this.previewItems.update((items) =>
          items.map((i) => (i.id === nextAudio.id ? { ...i, isAnalyzing: false } : i)),
        );
        this.isAudioTranscribing.set(false);
        this.processNextAudioQueueItem();
      },
    });
  }

  onImageSelected(event: any): void {
    const file = event.target.files?.[0];
    if (!file) return;

    const previewItem = this.mediaPreviewService.createImagePreview(file);
    this.previewItems.update((items) => [...items, previewItem]);
    event.target.value = '';
  }

  onVoiceSelected(event: any): void {
    const file = event.target.files?.[0];
    if (!file) return;

    const blobUrl = URL.createObjectURL(file);
    const previewItem: MediaPreviewItem = {
      id: 'aud_' + Math.random().toString(36).substring(2, 9),
      type: 'audio',
      blobUrl,
      file,
      name: file.name,
      isAnalyzing: false,
      isAnalyzed: false,
    };
    this.previewItems.update((items) => [...items, previewItem]);
    event.target.value = '';
  }

  transcribeAudioItem(item: MediaPreviewItem): void {
    if (item.type !== 'audio' || item.isAnalyzing) return;

    this.previewItems.update((items) =>
      items.map((i) => (i.id === item.id ? { ...i, isAnalyzing: true } : i)),
    );
    this.isAudioTranscribing.set(true);

    this.authService.transcribeAudio(item.file).subscribe({
      next: (res) => {
        const transcribedText = res.text.trim();
        if (transcribedText) {
          const currentInput = this.foodInput().trim();
          if (currentInput) {
            this.foodInput.set(`${currentInput}, ${transcribedText}`);
          } else {
            this.foodInput.set(transcribedText);
          }
        }

        this.previewItems.update((items) =>
          items.map((i) => (i.id === item.id ? { ...i, isAnalyzing: false, isAnalyzed: true } : i)),
        );
        this.isAudioTranscribing.set(false);
      },
      error: (err) => {
        console.error('Failed to transcribe audio:', err);
        alert('Failed to transcribe audio. Please try again.');
        this.previewItems.update((items) =>
          items.map((i) => (i.id === item.id ? { ...i, isAnalyzing: false } : i)),
        );
        this.isAudioTranscribing.set(false);
      },
    });
  }

  removePreviewItem(id: string): void {
    const item = this.previewItems().find((i) => i.id === id);
    if (item) {
      URL.revokeObjectURL(item.blobUrl);
      this.previewItems.update((items) => items.filter((i) => i.id !== id));
    }
  }

  analyzeImageItem(item: MediaPreviewItem): void {
    if (item.type !== 'image' || item.isAnalyzing) return;

    this.isQueueProcessing = false;
    this.currentScanningItem.set(item);

    this.previewItems.update((items) =>
      items.map((i) => (i.id === item.id ? { ...i, isAnalyzing: true } : i)),
    );

    this.isImageAnalyzing.set(true);
    this.showConfirmationDialog.set(false);
    this.nonFoodWarning.set(false);
    this.selectedImageName.set(item.name);

    this.authService.analyzeImage(item.file as File).subscribe({
      next: (res) => {
        this.isImageAnalyzing.set(false);
        this.previewItems.update((items) =>
          items.map((i) => (i.id === item.id ? { ...i, isAnalyzing: false } : i)),
        );
        this.detectedFood.set(res.food_name);
        this.detectionConfidence.set(res.confidence);
        this.nonFoodWarning.set(!res.is_food);
        this.showConfirmationDialog.set(true);
      },
      error: (err) => {
        this.isImageAnalyzing.set(false);
        this.previewItems.update((items) =>
          items.map((i) => (i.id === item.id ? { ...i, isAnalyzing: false } : i)),
        );
        this.selectedImageName.set('');
        this.currentScanningItem.set(null);
        console.error('Image analysis failed:', err);
      },
    });
  }

  confirmDetection(): void {
    const currentInput = this.foodInput().trim();
    const newFood = this.detectedFood().trim();

    if (currentInput) {
      if (currentInput.endsWith(',')) {
        this.foodInput.set(`${currentInput} ${newFood}`);
      } else {
        this.foodInput.set(`${currentInput}, ${newFood}`);
      }
    } else {
      this.foodInput.set(newFood);
    }

    const activeItem = this.currentScanningItem();
    if (activeItem) {
      this.previewItems.update((items) =>
        items.map((i) => (i.id === activeItem.id ? { ...i, isAnalyzed: true } : i)),
      );
      this.currentScanningItem.set(null);
    }

    this.showConfirmationDialog.set(false);
    this.selectedImageName.set('');

    if (this.isQueueProcessing) {
      this.processNextQueueItem();
    }
  }

  dismissDetection(): void {
    const activeItem = this.currentScanningItem();
    if (activeItem) {
      this.previewItems.update((items) =>
        items.map((i) => (i.id === activeItem.id ? { ...i, isAnalyzed: false } : i)),
      );
      this.currentScanningItem.set(null);
    }

    this.showConfirmationDialog.set(false);
    this.selectedImageName.set('');

    if (this.isQueueProcessing) {
      this.processNextQueueItem();
    }
  }

  openImageOptionModal(): void {
    this.isImageOptionModalOpen.set(true);
    this.imageMode.set('select');
    this.cameraError.set(null);
  }

  closeImageOptionModal(): void {
    this.stopCamera();
    this.isImageOptionModalOpen.set(false);
  }

  async startCamera(): Promise<void> {
    this.cameraError.set(null);
    this.imageMode.set('camera');
    
    setTimeout(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false
        });
        this.cameraStream = stream;
        const video = this.cameraVideoRef?.nativeElement;
        if (video) {
          video.srcObject = stream;
        } else {
          const videoElement = document.getElementById('cameraVideo') as HTMLVideoElement;
          if (videoElement) {
            videoElement.srcObject = stream;
          }
        }
      } catch (err) {
        console.error('Camera access failed:', err);
        this.cameraError.set('Could not access camera. Please check your browser permissions.');
      }
    }, 100);
  }

  stopCamera(): void {
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach((track) => track.stop());
      this.cameraStream = null;
    }
    this.cameraError.set(null);
  }

  capturePhoto(): void {
    const video = this.cameraVideoRef?.nativeElement || document.getElementById('cameraVideo') as HTMLVideoElement;
    if (!video || !this.cameraStream) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) {
          const file = new File([blob], `Camera_${Date.now()}.jpg`, { type: 'image/jpeg' });
          const previewItem = this.mediaPreviewService.createImagePreview(file);
          this.previewItems.update((items) => [...items, previewItem]);
          this.closeImageOptionModal();
        }
      }, 'image/jpeg', 0.95);
    }
  }

  triggerImageUpload(inputEl: HTMLInputElement): void {
    inputEl.click();
    this.closeImageOptionModal();
  }

  openVoiceOptionModal(): void {
    this.isVoiceOptionModalOpen.set(true);
    this.voiceMode.set('select');
    this.voiceError.set(null);
  }

  closeVoiceOptionModal(): void {
    if (this.voiceMode() === 'recording') {
      this.cancelVoiceRecording();
    }
    this.isVoiceOptionModalOpen.set(false);
  }

  async startVoiceRecording(): Promise<void> {
    this.voiceError.set(null);
    this.voiceMode.set('recording');
    try {
      await this.mediaPreviewService.startRecording();
    } catch (err) {
      console.error('Microphone access failed:', err);
      this.voiceError.set('Could not access microphone. Please check your browser permissions.');
      this.voiceMode.set('select');
    }
  }

  async stopAndUseVoiceRecording(): Promise<void> {
    try {
      const previewItem = await this.mediaPreviewService.stopRecording();
      this.previewItems.update((items) => [...items, previewItem]);
      this.closeVoiceOptionModal();
    } catch (err) {
      console.error('Stop recording failed:', err);
      this.closeVoiceOptionModal();
    }
  }

  async cancelVoiceRecording(): Promise<void> {
    try {
      await this.mediaPreviewService.stopRecording();
    } catch (err) {
      console.error('Cancel recording failed:', err);
    }
    this.voiceMode.set('select');
  }

  triggerVoiceUpload(inputEl: HTMLInputElement): void {
    inputEl.click();
    this.closeVoiceOptionModal();
  }

  onLogout(): void {
    // Revoke all preview blob URLs on logout to prevent memory leaks
    this.previewItems().forEach((item) => URL.revokeObjectURL(item.blobUrl));
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  openLogModal(): void {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    this.logDateTime.set(`${year}-${month}-${day}T${hours}:${minutes}`);
    this.isLogModalOpen.set(true);
  }

  confirmLogMeal(): void {
    const userid = this.authService.getUserId();
    if (!userid || !this.mealBreakdown()) {
      alert('Error: Session not found or nutritional report missing.');
      return;
    }

    const breakdown = this.mealBreakdown()!;
    const payload = {
      description: this.foodInput(),
      time: this.logDateTime(),
      report: {
        calories: breakdown.calories,
        protein: breakdown.protein,
        carbs: breakdown.carbs,
        fat: breakdown.fat,
        grade: breakdown.grade,
      },
    };

    // Close log modal immediately before making the call
    this.isLogModalOpen.set(false);

    this.authService.addMealLog(userid, payload).subscribe({
      next: () => {
        // Show success modal
        this.isSuccessModalOpen.set(true);

        // Reset everything
        this.previewItems().forEach((item) => URL.revokeObjectURL(item.blobUrl));
        this.previewItems.set([]);
        this.foodInput.set('');
        this.showResult.set(false);
        this.mealBreakdown.set(null);
        this.selectedImageName.set('');
        this.showConfirmationDialog.set(false);
        this.detectedFood.set('');
      },
      error: (err) => {
        console.error('Failed to log meal:', err);
        alert('Failed to log meal. Please try again.');
      },
    });
  }

  private formatLogDate(isoString: string): string {
    try {
      const dt = new Date(isoString);
      return dt.toLocaleString();
    } catch {
      return isoString;
    }
  }
}
