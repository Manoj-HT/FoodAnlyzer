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
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AuthService, User } from '../../services/auth';
import { IndexedDbService } from '../../services/indexed-db';
import { DeviceCapabilityService } from '../../services/device-capability';
import { MediaPreviewService, MediaPreviewItem } from '../../services/media-preview';
import { ModalComponent } from '../../utilities/components/modal/modal';
import { AccordionStateService } from '../../services/accordion-state';
import { LogsStateService } from '../../services/logs-state';
import { SectionHeaderComponent } from '../section-header/section-header';

export type TimeSource = 'explicit' | 'averaged_1w' | 'current';

export interface AnalyzedMealEntry {
  description: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  grade: string;
  tips: string[];
  time: string;
  time_source: TimeSource;
  time_label: string;
  period?: string | null;
  sample_count?: number;
  included?: boolean;
}

export interface MealBreakdown {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  grade: string;
  tips: string[];
  is_multi?: boolean;
  entries?: AnalyzedMealEntry[];
}

export interface ActivityTask {
  task: string;
  details?: string;
  calories_burned: number;
}

export interface AnalyzedActivityEntry {
  description: string;
  clean_title: string;
  calories_burned: number;
  duration_minutes: number;
  intensity: string;
  activity_type: string;
  tasks?: ActivityTask[];
  tips: string[];
  time: string;
  time_source: TimeSource;
  time_label: string;
  period?: string | null;
  sample_count?: number;
  included?: boolean;
}

export interface ActivityBreakdown {
  clean_title?: string;
  calories_burned: number;
  duration_minutes: number;
  intensity: string;
  activity_type: string;
  tasks?: ActivityTask[];
  tips: string[];
  is_multi?: boolean;
  entries?: AnalyzedActivityEntry[];
}

@Component({
  selector: 'app-what-you-ate-today',
  standalone: true,
  imports: [FormsModule, ModalComponent, SectionHeaderComponent],
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
  loggedSuccessCount = signal(1);
  isAudioTranscribing = signal(false);
  logDateTime = signal('');
  preselectedTime = signal('');
  isAnalyzing = signal(false);
  showResult = signal(false);
  mealBreakdown = signal<MealBreakdown | null>(null);
  pendingMealEntries = signal<AnalyzedMealEntry[]>([]);
  selectedMealCount = computed(() =>
    this.pendingMealEntries().filter((e) => e.included !== false && e.description.trim().length > 0).length
  );

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
  activityLoggedSuccessCount = signal(1);
  activityLogDateTime = signal('');
  pendingActivityEntries = signal<AnalyzedActivityEntry[]>([]);
  selectedActivityCount = computed(() =>
    this.pendingActivityEntries().filter(
      (e) => e.included !== false && (e.clean_title || e.description).trim().length > 0
    ).length
  );
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

  async runFinalFoodAnalysis(): Promise<void> {
    if (!this.foodInput().trim()) return;

    this.isAnalyzing.set(true);
    this.showResult.set(false);

    const context = await this.getAnalysisContext('meal');

    this.authService.analyzeFood(this.foodInput(), context).subscribe({
      next: (res) => {
        const entries: AnalyzedMealEntry[] =
          Array.isArray(res.entries) && res.entries.length > 0
            ? res.entries
            : [
                {
                  description: this.foodInput().trim(),
                  calories: res.calories,
                  protein: res.protein,
                  carbs: res.carbs,
                  fat: res.fat,
                  grade: res.grade,
                  tips: res.tips,
                  time: this.preselectedTime() || this.formatLocalDateTime(new Date()),
                  time_source: this.preselectedTime() ? 'explicit' : 'current',
                  time_label: 'Current time',
                },
              ];

        const breakdown: MealBreakdown = {
          calories: res.calories,
          protein: res.protein,
          carbs: res.carbs,
          fat: res.fat,
          grade: res.grade,
          tips: res.tips,
          is_multi: Boolean(res.is_multi && entries.length > 1),
          entries,
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
    this.voiceMode.set('select');
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
    } catch (err) {
      console.error('Stop recording failed:', err);
    } finally {
      this.voiceMode.set('select');
      this.isVoiceOptionModalOpen.set(false);
    }
  }

  cancelVoiceRecording(): void {
    this.voiceMode.set('select');
    this.mediaPreviewService.cancelRecording();
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

  private formatLocalDateTime(dt: Date): string {
    const year = dt.getFullYear();
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    const hours = String(dt.getHours()).padStart(2, '0');
    const minutes = String(dt.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  private formatLocalDate(dt: Date): string {
    const year = dt.getFullYear();
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private async getAnalysisContext(kind: 'meal' | 'activity'): Promise<{
    userid?: string;
    client_now: string;
    recent_log_times: string[];
  }> {
    const now = new Date();
    const clientNow = this.formatLocalDateTime(now);
    const userid = this.authService.getUserId();
    const recentTimes: string[] = [];

    if (userid) {
      try {
        const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const cutoffStr = this.formatLocalDate(cutoff);
        const logs =
          kind === 'meal'
            ? await this.indexedDb.getMealLogs(userid)
            : await this.indexedDb.getActivityLogs(userid);

        for (const item of logs) {
          if (item.date && item.time && item.date >= cutoffStr) {
            recentTimes.push(`${item.date}T${item.time}`);
          }
        }
      } catch (e) {
        console.warn('Could not read IndexedDB recent logs for time averaging:', e);
      }
    }

    return {
      ...(userid ? { userid } : {}),
      client_now: clientNow,
      recent_log_times: recentTimes,
    };
  }

  getTimeSourceBadgeText(entry: {
    time_source?: TimeSource;
    sample_count?: number;
    period?: string | null;
  }): string {
    const periodLabel = entry.period ? entry.period.replace('_', ' ') : '';
    if (entry.time_source === 'explicit') {
      return 'Detected time';
    }
    if (entry.time_source === 'averaged_1w') {
      if (entry.sample_count && entry.sample_count > 0) {
        return `7-day ${periodLabel} avg (${entry.sample_count} log${entry.sample_count === 1 ? '' : 's'})`;
      }
      return periodLabel ? `Default ${periodLabel} time` : 'Default period time';
    }
    return 'Current time';
  }

  openLogModal(): void {
    const breakdown = this.mealBreakdown();
    const fallbackTime = this.preselectedTime() || this.formatLocalDateTime(new Date());

    if (breakdown?.entries && breakdown.entries.length > 0) {
      const cloned: AnalyzedMealEntry[] = breakdown.entries.map((entry, idx) => ({
        ...entry,
        time:
          idx === 0 && breakdown.entries!.length === 1 && this.preselectedTime()
            ? this.preselectedTime()
            : entry.time || fallbackTime,
        time_source:
          idx === 0 && breakdown.entries!.length === 1 && this.preselectedTime()
            ? 'explicit'
            : entry.time_source || 'current',
        included: true,
      }));
      this.pendingMealEntries.set(cloned);
      this.logDateTime.set(cloned[0].time);
    } else if (breakdown) {
      this.pendingMealEntries.set([
        {
          description: this.foodInput().trim(),
          calories: breakdown.calories,
          protein: breakdown.protein,
          carbs: breakdown.carbs,
          fat: breakdown.fat,
          grade: breakdown.grade,
          tips: breakdown.tips,
          time: fallbackTime,
          time_source: this.preselectedTime() ? 'explicit' : 'current',
          time_label: 'Current time',
          included: true,
        },
      ]);
      this.logDateTime.set(fallbackTime);
    }

    this.isLogModalOpen.set(true);
  }

  confirmLogMeal(): void {
    const userid = this.authService.getUserId();
    if (!userid || !this.mealBreakdown()) {
      alert('Error: Session not found or nutritional report missing.');
      return;
    }

    const selectedEntries = this.pendingMealEntries().filter(
      (e) => e.included !== false && e.description.trim().length > 0
    );
    if (selectedEntries.length === 0) {
      return;
    }

    // Close log modal immediately before making the calls
    this.isLogModalOpen.set(false);
    this.loggedSuccessCount.set(selectedEntries.length);

    const apiRequests = selectedEntries.map((entry) => {
      const entryTime = entry.time || this.formatLocalDateTime(new Date());
      const logDt = new Date(entryTime);
      const validDt = isNaN(logDt.getTime()) ? new Date() : logDt;
      const dateStr = this.formatLocalDate(validDt);
      const timeStr = `${String(validDt.getHours()).padStart(2, '0')}:${String(validDt.getMinutes()).padStart(2, '0')}`;

      this.indexedDb
        .addMealLog({
          userId: userid,
          date: dateStr,
          time: timeStr,
          time_period:
            validDt.getHours() < 11
              ? 'Breakfast'
              : validDt.getHours() < 16
                ? 'Lunch'
                : validDt.getHours() < 20
                  ? 'Dinner'
                  : 'Snacks',
          description: entry.description.trim(),
          food_item: entry.description.trim(),
          calories: entry.calories,
          protein: entry.protein,
          carbs: entry.carbs,
          fat: entry.fat,
          grade: entry.grade,
          tips: entry.tips ? entry.tips.join('; ') : '',
        })
        .catch((err) => console.error('IndexedDB save error:', err));

      const payload = {
        description: entry.description.trim(),
        time: entryTime,
        report: {
          calories: entry.calories,
          protein: entry.protein,
          carbs: entry.carbs,
          fat: entry.fat,
          grade: entry.grade,
        },
      };

      return this.authService.addMealLog(userid, payload).pipe(
        catchError((err) => {
          console.error('Failed to log meal to server:', err);
          return of(null);
        })
      );
    });

    const resetMealForm = () => {
      this.previewItems().forEach((item) => URL.revokeObjectURL(item.blobUrl));
      this.previewItems.set([]);
      this.foodInput.set('');
      this.preselectedTime.set('');
      this.showResult.set(false);
      this.mealBreakdown.set(null);
      this.pendingMealEntries.set([]);
      this.selectedImageName.set('');
      this.showConfirmationDialog.set(false);
      this.detectedFood.set('');
    };

    forkJoin(apiRequests).subscribe({
      next: () => {
        this.logsState.invalidateCache();
        this.isSuccessModalOpen.set(true);
        resetMealForm();
      },
      error: () => {
        // Even if server request fails, offline log succeeded locally!
        this.isSuccessModalOpen.set(true);
        resetMealForm();
      },
    });
  }

  applyActivitySuggestion(suggestion: string): void {
    this.activityInput.set(suggestion);
  }

  async onAnalyzeActivity(): Promise<void> {
    const text = this.activityInput().trim();
    if (!text) return;

    this.isActivityAnalyzing.set(true);
    this.showActivityResult.set(false);

    const context = await this.getAnalysisContext('activity');

    this.authService.analyzeActivity(text, context).subscribe({
      next: (res) => {
        const entries: AnalyzedActivityEntry[] =
          Array.isArray(res.entries) && res.entries.length > 0
            ? res.entries
            : [
                {
                  description: text,
                  clean_title: res.clean_title || text,
                  calories_burned: res.calories_burned,
                  duration_minutes: res.duration_minutes,
                  intensity: res.intensity,
                  activity_type: res.activity_type,
                  tasks: res.tasks || [],
                  tips: res.tips || [],
                  time: this.formatLocalDateTime(new Date()),
                  time_source: 'current',
                  time_label: 'Current time',
                },
              ];

        this.activityBreakdown.set({
          ...res,
          is_multi: Boolean(res.is_multi && entries.length > 1),
          entries,
        });
        this.isActivityAnalyzing.set(false);
        this.showActivityResult.set(true);
      },
      error: (err) => {
        this.isActivityAnalyzing.set(false);
        console.error('Activity analysis failed:', err);
        alert('Failed to analyze activity. Please try again.');
      },
    });
  }

  openActivityLogModal(): void {
    const breakdown = this.activityBreakdown();
    const fallbackTime = this.formatLocalDateTime(new Date());

    if (breakdown?.entries && breakdown.entries.length > 0) {
      const cloned: AnalyzedActivityEntry[] = breakdown.entries.map((entry) => ({
        ...entry,
        clean_title: entry.clean_title || entry.description,
        time: entry.time || fallbackTime,
        time_source: entry.time_source || 'current',
        included: true,
      }));
      this.pendingActivityEntries.set(cloned);
      this.activityLogDateTime.set(cloned[0].time);
    } else if (breakdown) {
      this.pendingActivityEntries.set([
        {
          description: this.activityInput().trim(),
          clean_title: breakdown.clean_title || this.activityInput().trim(),
          calories_burned: breakdown.calories_burned,
          duration_minutes: breakdown.duration_minutes,
          intensity: breakdown.intensity,
          activity_type: breakdown.activity_type,
          tasks: breakdown.tasks || [],
          tips: breakdown.tips || [],
          time: fallbackTime,
          time_source: 'current',
          time_label: 'Current time',
          included: true,
        },
      ]);
      this.activityLogDateTime.set(fallbackTime);
    }

    this.isActivityLogModalOpen.set(true);
  }

  confirmLogActivity(): void {
    const userid = this.authService.getUserId();
    const breakdown = this.activityBreakdown();
    if (!userid || !breakdown) {
      alert('Error: User session missing or activity data invalid.');
      return;
    }

    const selectedEntries = this.pendingActivityEntries().filter(
      (e) => e.included !== false && (e.clean_title || e.description).trim().length > 0
    );
    if (selectedEntries.length === 0) {
      return;
    }

    this.isActivityLogModalOpen.set(false);
    this.activityLoggedSuccessCount.set(selectedEntries.length);

    const apiRequests = selectedEntries.map((entry) => {
      const entryTime = entry.time || this.formatLocalDateTime(new Date());
      const actDt = new Date(entryTime);
      const validDt = isNaN(actDt.getTime()) ? new Date() : actDt;
      const actDateStr = this.formatLocalDate(validDt);
      const actTimeStr = `${String(validDt.getHours()).padStart(2, '0')}:${String(validDt.getMinutes()).padStart(2, '0')}`;
      const desc = (entry.clean_title || entry.description).trim();

      this.indexedDb
        .addActivityLog({
          userId: userid,
          date: actDateStr,
          time: actTimeStr,
          activity_name: desc,
          duration_minutes: entry.duration_minutes || 30,
          calories_burned: entry.calories_burned || 100,
          intensity: entry.intensity || 'Moderate',
        })
        .catch((err) => console.error('IndexedDB activity save error:', err));

      const payload = {
        description: desc,
        time: entryTime,
        report: {
          clean_title: desc,
          calories_burned: entry.calories_burned,
          duration_minutes: entry.duration_minutes,
          intensity: entry.intensity,
          activity_type: entry.activity_type,
          tasks: entry.tasks || [],
          tips: entry.tips || [],
        },
      };

      return this.authService.addActivityLog(userid, payload).pipe(
        catchError((err) => {
          console.error('Failed to log activity to server:', err);
          return of(null);
        })
      );
    });

    const resetActivityForm = () => {
      this.activityInput.set('');
      this.showActivityResult.set(false);
      this.activityBreakdown.set(null);
      this.pendingActivityEntries.set([]);
    };

    forkJoin(apiRequests).subscribe({
      next: () => {
        this.logsState.invalidateCache();
        this.isActivitySuccessModalOpen.set(true);
        resetActivityForm();
      },
      error: () => {
        this.isActivitySuccessModalOpen.set(true);
        resetActivityForm();
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
