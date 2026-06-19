import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../services/auth';
import { NavigationComponent } from '../navigation/navigation';
import { ModalComponent } from '../../utilities/components/modal/modal';

interface MealLog {
  id: string;
  description: string;
  time: string;
  report: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    grade: string;
  };
}

interface DayColumn {
  dateLabel: string;
  dayName: string;
  dateString: string;
  sections: {
    morning: MealLog[];
    noon: MealLog[];
    evening: MealLog[];
    lateNight: MealLog[];
  };
}

@Component({
  selector: 'app-your-logs',
  standalone: true,
  imports: [CommonModule, NavigationComponent, ModalComponent],
  templateUrl: './your-logs.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './your-logs.scss',
})
export class YourLogsComponent implements OnInit {
  private readonly authService = inject(AuthService);

  logs = signal<MealLog[]>([]);
  isLoading = signal(true);
  errorMsg = signal('');

  // Selected log for the detail modal
  selectedLog = signal<MealLog | null>(null);
  isDetailModalOpen = signal(false);

  // How many weeks we are offset from the current week (0 = current week, 1 = 1 week ago, etc.)
  weekOffset = signal<number>(0);

  // Dynamic computed columns for the 7 days (left is latest/today, and 6 preceding days)
  dayColumns = computed<DayColumn[]>(() => {
    const columns: DayColumn[] = [];
    const today = new Date();
    const allLogs = this.logs();
    const offsetDays = this.weekOffset() * 7;

    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(today.getDate() - offsetDays - i);

      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateString = `${year}-${month}-${day}`;

      const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });

      // Find logs matching this date
      const dayLogs = allLogs.filter((log) => log.time.split('T')[0] === dateString);

      // Categorize into 4 sections
      const morning: MealLog[] = [];
      const noon: MealLog[] = [];
      const evening: MealLog[] = [];
      const lateNight: MealLog[] = [];

      dayLogs.forEach((log) => {
        const timePart = log.time.split('T')[1] || '';
        const hour = parseInt(timePart.split(':')[0] || '0', 10);

        if (hour >= 5 && hour < 12) {
          morning.push(log);
        } else if (hour >= 12 && hour < 17) {
          noon.push(log);
        } else if (hour >= 17 && hour < 21) {
          evening.push(log);
        } else {
          lateNight.push(log);
        }
      });

      columns.push({
        dateLabel,
        dayName,
        dateString,
        sections: {
          morning,
          noon,
          evening,
          lateNight,
        },
      });
    }

    return columns;
  });

  weekRangeLabel = computed<string>(() => {
    const columns = this.dayColumns();
    if (columns.length === 0) return '';
    const latestDate = new Date(columns[0].dateString);
    const oldestDate = new Date(columns[columns.length - 1].dateString);
    
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
    return `${oldestDate.toLocaleDateString('en-US', options)} - ${latestDate.toLocaleDateString('en-US', options)}`;
  });

  loadLogs(): void {
    const userid = this.authService.getUserId();
    if (userid) {
      this.isLoading.set(true);
      this.authService.getMealLogs(userid, this.weekOffset()).subscribe({
        next: (data) => {
          this.logs.set(data);
          this.isLoading.set(false);
        },
        error: (err) => {
          console.error('Failed to load logs:', err);
          this.errorMsg.set('Unable to retrieve meal logs at this time.');
          this.isLoading.set(false);
        },
      });
    } else {
      this.isLoading.set(false);
      this.errorMsg.set('User session not found.');
    }
  }

  nextWeek(): void {
    if (this.weekOffset() > 0) {
      this.weekOffset.update(offset => offset - 1);
      this.loadLogs();
    }
  }

  prevWeek(): void {
    this.weekOffset.update(offset => offset + 1);
    this.loadLogs();
  }

  ngOnInit(): void {
    this.loadLogs();
  }

  openDetailModal(log: MealLog): void {
    this.selectedLog.set(log);
    this.isDetailModalOpen.set(true);
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

  formatFullDate(isoString: string): string {
    try {
      const dt = new Date(isoString);
      return dt.toLocaleString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  }
}
