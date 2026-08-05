import {
  Component,
  OnInit,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../services/auth';
import { LogsStateService } from '../../services/logs-state';

@Component({
  selector: 'app-day-overview',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './day-overview.html',
  styleUrl: './day-overview.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class DayOverviewComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);
  private readonly logsState = inject(LogsStateService);

  dateParam = signal('');
  formattedDateLabel = signal('');
  isLoading = signal(true);
  dayData = signal<any>(null);

  ngOnInit(): void {
    this.route.params.subscribe((params) => {
      const date = params['date'];
      if (date) {
        this.dateParam.set(date);
        this.formattedDateLabel.set(this.formatFullDate(date));
        this.fetchDayData(date);
      }
    });
  }

  fetchDayData(dateStr: string): void {
    const userid = this.authService.getUserId();
    if (!userid) {
      this.router.navigate(['/login']);
      return;
    }

    this.isLoading.set(true);
    this.logsState.getDayOverview(this.authService, userid, dateStr).subscribe({
      next: (data) => {
        this.dayData.set(data);
        this.isLoading.set(false);
      },
      error: (err) => {
        console.error('Failed to load day overview data:', err);
        this.isLoading.set(false);
      },
    });
  }

  goBackToLogs(): void {
    this.router.navigate(['/logs']);
  }

  goToLogActivityOrMeal(): void {
    this.router.navigate(['/dashboard']);
  }

  formatTime(isoString: string): string {
    try {
      const dt = new Date(isoString);
      return dt.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      const parts = isoString.split('T');
      return parts[1] || isoString;
    }
  }

  formatFullDate(dateStr: string): string {
    try {
      const [year, month, day] = dateStr.split('-').map(Number);
      const dt = new Date(year, month - 1, day);
      return dt.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return dateStr;
    }
  }
}
