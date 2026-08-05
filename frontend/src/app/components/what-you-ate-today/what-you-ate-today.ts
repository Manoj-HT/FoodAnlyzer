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
import { Router, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService, User } from '../../services/auth';
import { IndexedDbService } from '../../services/indexed-db';
import { DeviceCapabilityService } from '../../services/device-capability';
import { MediaPreviewService, MediaPreviewItem } from '../../services/media-preview';
import { ModalComponent } from '../../utilities/components/modal/modal';
import { AccordionStateService } from '../../services/accordion-state';
import { LogsStateService } from '../../services/logs-state';

export interface MealBreakdown {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  grade: string;
  tips: string[];
}

export interface ActivityTask {
  task: string;
  details?: string;
  calories_burned: number;
}

export interface ActivityBreakdown {
  clean_title?: string;
  calories_burned: number;
  duration_minutes: number;
  intensity: string;
  activity_type: string;
  tasks?: ActivityTask[];
  tips: string[];
}

@Component({
  selector: 'app-what-you-ate-today',
  standalone: true,
  imports: [FormsModule, ModalComponent],
  templateUrl: './what-you-ate-today.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './what-you-ate-today.scss',
})
export class WhatYouAteTodayComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly indexedDb = inject(IndexedDbService);
  readonly deviceCapability = inject(DeviceCapabilityService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly mediaPreviewService = inject(MediaPreviewService);
  readonly accordionService = inject(AccordionStateService);
  private readonly logsState = inject(LogsStateService);

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
  preselectedTime = signal('');
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

  // Activity Logging States
  activityInput = signal('');
  isActivityAnalyzing = signal(false);
  showActivityResult = signal(false);
  activityBreakdown = signal<ActivityBreakdown | null>(null);
  isActivityLogModalOpen = signal(false);
  isActivitySuccessModalOpen = signal(false);
  activityLogDateTime = signal('');
  activitySuggestions = signal<string[]>([
    '30 min morning jog in the park',
    '45 mins weight training at gym',
    '5 km outdoor running',
    '1 hour evening brisk walk',
    '30 mins intense cycling'
  ]);

  @ViewChild('cameraVideo', { static: false }) cameraVideoRef?: ElementRef<HTMLVideoElement>;
  private cameraStream: MediaStream | null = null;

  ngOnInit(): void {
    const localUser = this.authService.getLocalUser();
    if (localUser) {
      this.userName.set(localUser.name || 'Member');
      this.userEmail.set(localUser.email || '');
      this.userBio.set(localUser.userdetails || 'No profile details available.');
    }

    // Read query params for pre-populating food input and time
    this.route.queryParams.subscribe(params => {
      if (params['food']) {
        this.foodInput.set(params['food']);
      }
      if (params['time']) {
        this.preselectedTime.set(params['time']);
      }
    });
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
    if (this.foodInput().trim()) {
      this.runFinalFoodAnalysis();
      return;
    }

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
    if (this.preselectedTime()) {
      this.logDateTime.set(this.preselectedTime());
    } else {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');

      this.logDateTime.set(`${year}-${month}-${day}T${hours}:${minutes}`);
    }
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

    // Save to local IndexedDB store (Zero-Cloud DB, 6-Month Data Lifecycle)
    const logDt = new Date(this.logDateTime() || Date.now());
    const dateStr = logDt.toISOString().split('T')[0];
    const timeStr = `${String(logDt.getHours()).padStart(2, '0')}:${String(logDt.getMinutes()).padStart(2, '0')}`;
    
    this.indexedDb.addMealLog({
      userId: userid,
      date: dateStr,
      time: timeStr,
      time_period: logDt.getHours() < 11 ? 'Breakfast' : logDt.getHours() < 16 ? 'Lunch' : logDt.getHours() < 20 ? 'Dinner' : 'Snacks',
      description: this.foodInput(),
      food_item: this.foodInput(),
      calories: breakdown.calories,
      protein: breakdown.protein,
      carbs: breakdown.carbs,
      fat: breakdown.fat,
      grade: breakdown.grade,
      tips: breakdown.tips ? breakdown.tips.join('; ') : ''
    }).catch(err => console.error('IndexedDB save error:', err));

    this.authService.addMealLog(userid, payload).subscribe({
      next: () => {
        this.logsState.invalidateCache();
        // Show success modal
        this.isSuccessModalOpen.set(true);

        // Reset everything
        this.previewItems().forEach((item) => URL.revokeObjectURL(item.blobUrl));
        this.previewItems.set([]);
        this.foodInput.set('');
        this.preselectedTime.set('');
        this.showResult.set(false);
        this.mealBreakdown.set(null);
        this.selectedImageName.set('');
        this.showConfirmationDialog.set(false);
        this.detectedFood.set('');
      },
      error: (err) => {
        console.error('Failed to log meal to server:', err);
        // Even if server request fails, offline log succeeded locally!
        this.isSuccessModalOpen.set(true);
        this.previewItems().forEach((item) => URL.revokeObjectURL(item.blobUrl));
        this.previewItems.set([]);
        this.foodInput.set('');
        this.showResult.set(false);
        this.mealBreakdown.set(null);
      },
    });
  }

  applyActivitySuggestion(suggestion: string): void {
    this.activityInput.set(suggestion);
  }

  onAnalyzeActivity(): void {
    const text = this.activityInput().trim();
    if (!text) return;

    this.isActivityAnalyzing.set(true);
    this.showActivityResult.set(false);

    this.authService.analyzeActivity(text).subscribe({
      next: (res) => {
        this.activityBreakdown.set(res);
        this.isActivityAnalyzing.set(false);
        this.showActivityResult.set(true);
      },
      error: (err) => {
        this.isActivityAnalyzing.set(false);
        console.error('Activity analysis failed:', err);
        alert('Failed to analyze activity. Please try again.');
      }
    });
  }

  openActivityLogModal(): void {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    this.activityLogDateTime.set(`${year}-${month}-${day}T${hours}:${minutes}`);
    this.isActivityLogModalOpen.set(true);
  }

  confirmLogActivity(): void {
    const userid = this.authService.getUserId();
    const breakdown = this.activityBreakdown();
    if (!userid || !breakdown) {
      alert('Error: User session missing or activity data invalid.');
      return;
    }

    const desc = breakdown.clean_title || this.activityInput();
    const payload = {
      description: desc,
      time: this.activityLogDateTime(),
      report: breakdown
    };

    this.isActivityLogModalOpen.set(false);

    // Save to client-side IndexedDB store
    const actDt = new Date(this.activityLogDateTime() || Date.now());
    const actDateStr = actDt.toISOString().split('T')[0];
    const actTimeStr = `${String(actDt.getHours()).padStart(2, '0')}:${String(actDt.getMinutes()).padStart(2, '0')}`;

    this.indexedDb.addActivityLog({
      userId: userid,
      date: actDateStr,
      time: actTimeStr,
      activity_name: desc,
      duration_minutes: breakdown.duration_minutes || 30,
      calories_burned: breakdown.calories_burned || 100,
      intensity: breakdown.intensity || 'Moderate'
    }).catch(err => console.error('IndexedDB activity save error:', err));

    this.authService.addActivityLog(userid, payload).subscribe({
      next: () => {
        this.logsState.invalidateCache();
        this.isActivitySuccessModalOpen.set(true);
        this.activityInput.set('');
        this.showActivityResult.set(false);
        this.activityBreakdown.set(null);
      },
      error: (err) => {
        console.error('Failed to log activity to server:', err);
        // Local save succeeded
        this.isActivitySuccessModalOpen.set(true);
        this.activityInput.set('');
        this.showActivityResult.set(false);
        this.activityBreakdown.set(null);
      }
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
