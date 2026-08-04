import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { finalize, retry, timer, catchError, throwError } from 'rxjs';
import { ServerStatusService } from '../services/server-status';
import { AuthService } from '../services/auth';

export const serverStatusInterceptor: HttpInterceptorFn = (req, next) => {
  const statusService = inject(ServerStatusService);
  const authService = inject(AuthService);
  const router = inject(Router);

  statusService.onRequestStarted();

  return next(req).pipe(
    retry({
      count: 2,
      delay: (error, retryCount) => {
        // Do NOT retry if error is 404 (Not Found), 401 (Unauthorized), 400 (Bad Request), or 403 (Forbidden)
        if (error instanceof HttpErrorResponse && [400, 401, 403, 404].includes(error.status)) {
          throw error;
        }
        return timer(retryCount * 2000);
      },
    }),
    catchError((error: HttpErrorResponse) => {
      // If any request to /users/ API returns 404 Not Found (or 401 Unauthorized for active sessions)
      if (req.url.includes('/users/')) {
        const isAuthEndpoint = req.url.includes('/users/login') || req.url.includes('/users/register') || req.url.includes('/users/check');
        
        if (error.status === 404 || (!isAuthEndpoint && error.status === 401)) {
          console.warn(`User API returned HTTP ${error.status} for ${req.url}. Automatically logging out...`);
          authService.logout();
          router.navigate(['/login']);
        }
      }
      return throwError(() => error);
    }),
    finalize(() => {
      statusService.onRequestFinished();
    })
  );
};
