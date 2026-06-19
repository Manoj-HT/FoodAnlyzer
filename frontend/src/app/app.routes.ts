import { Routes } from '@angular/router';
import { LoginComponent } from './components/login/login';
import { RegisterComponent } from './components/register/register';
import { WhatYouAteTodayComponent } from './components/what-you-ate-today/what-you-ate-today';
import { YourLogsComponent } from './components/your-logs/your-logs';
import { CurrentRecommendationComponent } from './components/current-recommendation/current-recommendation';
import { authGuard } from './guards/auth';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'register', component: RegisterComponent },
  { path: 'dashboard', component: WhatYouAteTodayComponent, canActivate: [authGuard] },
  { path: 'logs', component: YourLogsComponent, canActivate: [authGuard] },
  { path: 'recommendations', component: CurrentRecommendationComponent, canActivate: [authGuard] },
  { path: '', redirectTo: '/login', pathMatch: 'full' },
  { path: '**', redirectTo: '/login' },
];
