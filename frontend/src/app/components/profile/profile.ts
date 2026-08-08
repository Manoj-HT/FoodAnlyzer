import { Component, OnInit, inject, signal, ChangeDetectionStrategy, ViewChild, ElementRef } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { AuthService } from '../../services/auth';
import { IndexedDbService } from '../../services/indexed-db';
import { LogsStateService } from '../../services/logs-state';
import { ModalComponent } from '../../utilities/components/modal/modal';
import { SectionHeaderComponent } from '../section-header/section-header';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [FormsModule, ModalComponent, SectionHeaderComponent],
  templateUrl: './profile.html',
  styleUrl: './profile.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class ProfileComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly indexedDb = inject(IndexedDbService);
  private readonly logsState = inject(LogsStateService);
  private readonly router = inject(Router);

  userName = signal('Member');
  userEmail = signal('');
  userBio = signal('');
  
  // Details Modal
  isDetailsModalOpen = signal(false);
  additionalDetailsInput = signal('');
  detailsPlaceholderText = signal('');
  isUpdatingDetails = signal(false);

  // Import Modal & File Selection
  isImportModalOpen = signal(false);
  isImporting = signal(false);
  importStatusMessage = signal('');
  selectedImportFile: File | null = null;
  @ViewChild('fileInput') fileInputRef!: ElementRef<HTMLInputElement>;

  ngOnInit(): void {
    const userid = this.authService.getUserId();
    const storeUser = this.authService.currentUser() || this.authService.getLocalUser();

    if (storeUser && storeUser.userdetails) {
      this.userName.set(storeUser.name || 'Member');
      this.userEmail.set(storeUser.email || '');
      this.userBio.set(storeUser.userdetails);
    } else if (userid) {
      // If store doesn't contain user details, fetch from API once
      this.authService.getUserDetails(userid).subscribe({
        next: (user) => {
          this.userName.set(user.name || 'Member');
          this.userEmail.set(user.email || '');
          this.userBio.set(user.userdetails || '');
        },
        error: (err) => {
          console.error('Failed to load user details in profile:', err);
        },
      });
    }
  }

  openDetailsModal(): void {
    this.additionalDetailsInput.set('');
    this.isDetailsModalOpen.set(true);
  }

  submitAdditionalDetails(): void {
    const text = this.additionalDetailsInput().trim();
    if (!text) return;

    const userid = this.authService.getUserId();
    if (!userid) return;

    this.isUpdatingDetails.set(true);
    this.authService.updateDetails(userid, text).subscribe({
      next: (res) => {
        // Refetch user details on update success to sync store with backend
        this.authService.getUserDetails(userid, true).subscribe({
          next: (updatedUser) => {
            this.userName.set(updatedUser.name || 'Member');
            this.userEmail.set(updatedUser.email || '');
            this.userBio.set(updatedUser.userdetails || res.userdetails);
            this.isUpdatingDetails.set(false);
            this.isDetailsModalOpen.set(false);
          },
          error: () => {
            this.userBio.set(res.userdetails);
            this.isUpdatingDetails.set(false);
            this.isDetailsModalOpen.set(false);
          }
        });
      },
      error: (err) => {
        this.isUpdatingDetails.set(false);
        console.error('Failed to update profile details:', err);
      },
    });
  }

  async exportData(): Promise<void> {
    try {
      const userid = this.authService.getUserId() || 'default_user';
      const compressedBlob = await this.indexedDb.exportCompressedBackup(userid);
      const isGzip = 'CompressionStream' in window;
      const ext = isGzip ? 'json.gz' : 'json';
      const fileName = `FoodAnlyzer_Backup_${new Date().toISOString().split('T')[0]}.${ext}`;

      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const res = reader.result as string;
          const base64 = res.includes(',') ? res.split(',')[1] : res;
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(compressedBlob);
      });

      if (Capacitor.isNativePlatform()) {
        let savedFile;
        try {
          savedFile = await Filesystem.writeFile({
            path: fileName,
            data: base64Data,
            directory: Directory.Documents,
            recursive: true
          });
        } catch (docErr) {
          console.warn('Could not write to Documents, falling back to Cache:', docErr);
          savedFile = await Filesystem.writeFile({
            path: fileName,
            data: base64Data,
            directory: Directory.Cache,
            recursive: true
          });
        }

        await Share.share({
          title: 'Export FoodAnalyzer Backup',
          text: 'Here is your FoodAnalyzer health data backup.',
          url: savedFile.uri,
          dialogTitle: 'Save or Share Health Backup'
        });
      } else {
        const mimeType = isGzip ? 'application/gzip' : 'application/json';
        const dataUrl = `data:${mimeType};base64,${base64Data}`;
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err) {
      console.error('Export data failed:', err);
      alert('Failed to export data. Please try again.');
    }
  }

  triggerImportFileSelect(): void {
    if (this.fileInputRef?.nativeElement) {
      this.fileInputRef.nativeElement.value = '';
      this.fileInputRef.nativeElement.click();
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.selectedImportFile = input.files[0];
      this.importStatusMessage.set('');
      this.isImportModalOpen.set(true);
    }
  }

  cancelImport(): void {
    this.selectedImportFile = null;
    this.isImportModalOpen.set(false);
    if (this.fileInputRef?.nativeElement) {
      this.fileInputRef.nativeElement.value = '';
    }
  }

  async confirmImport(): Promise<void> {
    if (!this.selectedImportFile) return;

    this.isImporting.set(true);
    try {
      const success = await this.indexedDb.importCompressedBackup(this.selectedImportFile);
      if (success) {
        // Clear all cached responses so the app pulls fresh data from restored IndexedDB
        this.logsState.invalidateCache();
        this.importStatusMessage.set('Data successfully imported and updated!');
        setTimeout(() => {
          this.isImporting.set(false);
          this.cancelImport();
        }, 1000);
      } else {
        this.importStatusMessage.set('Failed to import backup file. Please ensure it is a valid .gz or .json backup.');
        this.isImporting.set(false);
      }
    } catch (e) {
      console.error('Import failed:', e);
      this.importStatusMessage.set('An error occurred during import.');
      this.isImporting.set(false);
    }
  }

  onLogout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
