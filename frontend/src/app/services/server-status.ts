import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class ServerStatusService {
  isColdStarting = signal(false);
  elapsedSeconds = signal(0);

  private activeRequests = 0;
  private timerId: any = null;
  private delayCheckTimeout: any = null;

  onRequestStarted(): void {
    this.activeRequests++;
    if (this.activeRequests === 1) {
      // Start a 3-second delay check. If request finishes in < 3s, modal won't show!
      this.delayCheckTimeout = setTimeout(() => {
        if (this.activeRequests > 0) {
          this.isColdStarting.set(true);
          this.elapsedSeconds.set(3);
          this.startTimer();
        }
      }, 3000);
    }
  }

  onRequestFinished(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.activeRequests === 0) {
      this.reset();
    }
  }

  private startTimer(): void {
    if (this.timerId) clearInterval(this.timerId);
    this.timerId = setInterval(() => {
      this.elapsedSeconds.update((s) => s + 1);
    }, 1000);
  }

  private reset(): void {
    if (this.delayCheckTimeout) {
      clearTimeout(this.delayCheckTimeout);
      this.delayCheckTimeout = null;
    }
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.isColdStarting.set(false);
    this.elapsedSeconds.set(0);
  }
}
