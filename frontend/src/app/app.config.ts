import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withXhr, withInterceptors } from '@angular/common/http';

import { routes } from './app.routes';
import { serverStatusInterceptor } from './interceptors/server-status.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withXhr(), withInterceptors([serverStatusInterceptor])),
  ],
};
