import { Injectable } from '@angular/core';
import { Observable, of, tap } from 'rxjs';
import { AuthService } from './auth';

export interface UnifiedLogsResponse {
  food_logs: any[];
  activity_logs: any[];
  inferred_logs: any[];
  low_data: boolean;
}

export interface CachedStreamData {
  timestamp: number;
  month: number;
  year: number;
  streamText: string;
  monthlyData: any;
  weeklyReports: any[];
}

export interface CachedDayOverview {
  dateStr: string;
  data: any;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class LogsStateService {
  // In-memory cache mapping weekOffset (0..3) to UnifiedLogsResponse
  private logsCache = new Map<number, UnifiedLogsResponse>();

  // In-memory cache for graph-data API response
  private graphDataCache: any = null;

  // In-memory cache for recommendation stream with monthly TTL
  private cachedStream: CachedStreamData | null = null;

  // Rolling Cache Queue for Day Overview API (Max 5 dates)
  private dayOverviewQueue: CachedDayOverview[] = [];

  private loadDayOverviewQueue(): void {
    if (this.dayOverviewQueue.length > 0) return;
    try {
      const raw = localStorage.getItem('cached_day_overviews');
      if (raw) {
        this.dayOverviewQueue = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('Failed to read cached day overviews from localStorage:', e);
    }
  }

  private saveDayOverviewQueue(): void {
    try {
      localStorage.setItem('cached_day_overviews', JSON.stringify(this.dayOverviewQueue));
    } catch (e) {
      console.warn('Failed to save cached day overviews to localStorage:', e);
    }
  }

  getDayOverview(authService: AuthService, userid: string, dateStr: string): Observable<any> {
    this.loadDayOverviewQueue();

    const existingIdx = this.dayOverviewQueue.findIndex(item => item.dateStr === dateStr);
    if (existingIdx !== -1) {
      const cached = this.dayOverviewQueue[existingIdx];
      // Move to end (most recently accessed)
      this.dayOverviewQueue.splice(existingIdx, 1);
      this.dayOverviewQueue.push(cached);
      this.saveDayOverviewQueue();
      return of(cached.data);
    }

    return authService.getDayOverview(userid, dateStr).pipe(
      tap((data) => {
        const idx = this.dayOverviewQueue.findIndex(item => item.dateStr === dateStr);
        if (idx !== -1) {
          this.dayOverviewQueue.splice(idx, 1);
        }

        this.dayOverviewQueue.push({
          dateStr,
          data,
          timestamp: Date.now()
        });

        // Enforce rolling queue limit of 5 items max (evict 6th oldest at index 0)
        while (this.dayOverviewQueue.length > 5) {
          this.dayOverviewQueue.shift();
        }

        this.saveDayOverviewQueue();
      })
    );
  }

  getUnifiedLogs(authService: AuthService, userid: string, weekOffset: number): Observable<UnifiedLogsResponse> {
    // If weekOffset <= 3 and we have cached data in memory, return instantly!
    if (weekOffset <= 3 && this.logsCache.has(weekOffset)) {
      return of(this.logsCache.get(weekOffset)!);
    }

    // Check localStorage for weekOffset <= 3
    if (weekOffset <= 3) {
      try {
        const raw = localStorage.getItem(`cached_unified_logs_week_${weekOffset}`);
        if (raw) {
          const data: UnifiedLogsResponse = JSON.parse(raw);
          this.logsCache.set(weekOffset, data);
          return of(data);
        }
      } catch (e) {
        console.warn(`Failed to read cached logs for week ${weekOffset} from localStorage:`, e);
      }
    }

    // Otherwise, fetch from HTTP API and cache if weekOffset <= 3
    return authService.getUnifiedLogs(userid, weekOffset).pipe(
      tap((data) => {
        if (weekOffset <= 3) {
          this.logsCache.set(weekOffset, data);
          try {
            localStorage.setItem(`cached_unified_logs_week_${weekOffset}`, JSON.stringify(data));
          } catch (e) {
            console.warn(`Failed to save logs for week ${weekOffset} to localStorage:`, e);
          }
        }
      })
    );
  }

  getGraphData(authService: AuthService, userid: string): Observable<any> {
    if (this.graphDataCache) {
      return of(this.graphDataCache);
    }

    try {
      const raw = localStorage.getItem('cached_graph_data');
      if (raw) {
        this.graphDataCache = JSON.parse(raw);
        return of(this.graphDataCache);
      }
    } catch (e) {
      console.warn('Failed to read cached graph data from localStorage:', e);
    }

    return authService.getGraphData(userid).pipe(
      tap((data) => {
        this.graphDataCache = data;
        try {
          localStorage.setItem('cached_graph_data', JSON.stringify(data));
        } catch (e) {
          console.warn('Failed to save graph data to localStorage:', e);
        }
      })
    );
  }

  // Recommendation Stream Caching with Monthly Expiration
  isStreamCacheValid(data: CachedStreamData | null): boolean {
    if (!data) return false;

    const now = new Date();
    const cachedDate = new Date(data.timestamp);

    // 1. Check if calendar month or year changed
    if (now.getMonth() !== cachedDate.getMonth() || now.getFullYear() !== cachedDate.getFullYear()) {
      return false;
    }

    // 2. Check if elapsed time > 30 days (2,592,000,000 ms)
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    if (now.getTime() - data.timestamp > thirtyDaysMs) {
      return false;
    }

    return true;
  }

  getCachedStream(): CachedStreamData | null {
    if (this.cachedStream && this.isStreamCacheValid(this.cachedStream)) {
      return this.cachedStream;
    }

    // Try loading from localStorage
    try {
      const raw = localStorage.getItem('cached_recommendations_stream');
      if (raw) {
        const parsed: CachedStreamData = JSON.parse(raw);
        if (this.isStreamCacheValid(parsed)) {
          this.cachedStream = parsed;
          return this.cachedStream;
        } else {
          // Stale, clear from localStorage
          localStorage.removeItem('cached_recommendations_stream');
        }
      }
    } catch (e) {
      console.warn('Failed to read cached recommendations stream from localStorage:', e);
    }

    return null;
  }

  setCachedStream(streamText: string, monthlyData: any, weeklyReports: any[]): void {
    const now = new Date();
    const streamObj: CachedStreamData = {
      timestamp: now.getTime(),
      month: now.getMonth(),
      year: now.getFullYear(),
      streamText,
      monthlyData,
      weeklyReports
    };

    this.cachedStream = streamObj;

    try {
      localStorage.setItem('cached_recommendations_stream', JSON.stringify(streamObj));
    } catch (e) {
      console.warn('Failed to save recommendations stream to localStorage:', e);
    }
  }

  // Clear/invalidate cached logs and graph data when a new meal or activity is logged
  invalidateCache(): void {
    this.logsCache.clear();
    this.graphDataCache = null;
    this.dayOverviewQueue = [];
    try {
      localStorage.removeItem('cached_graph_data');
      localStorage.removeItem('cached_day_overviews');
      for (let w = 0; w <= 3; w++) {
        localStorage.removeItem(`cached_unified_logs_week_${w}`);
      }
    } catch (e) {
      console.warn('Failed to clear cached logs & graph data:', e);
    }
  }

  invalidateWeek(weekOffset: number): void {
    this.logsCache.delete(weekOffset);
    try {
      localStorage.removeItem(`cached_unified_logs_week_${weekOffset}`);
    } catch (e) {
      console.warn(`Failed to clear cached logs for week ${weekOffset}:`, e);
    }
  }
}
