import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { AuthService } from '../../services/auth';

@Component({
  selector: 'app-navigation',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './navigation.html',
  styleUrl: './navigation.scss',
})
export class NavigationComponent {
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);

  // Initialize with current location pathname for immediate sync
  currentUrl = signal<string>(
    typeof window !== 'undefined' && window.location.pathname !== '/'
      ? window.location.pathname
      : this.router.url
  );

  shouldShowNav = signal<boolean>(false);

  constructor() {
    this.updateVisibility(this.currentUrl());

    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd)
    ).subscribe((event: any) => {
      const url = event.urlAfterRedirects || event.url;
      this.currentUrl.set(url);
      this.updateVisibility(url);

      if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
  }

  private updateVisibility(url: string): void {
    const isUnprotectedRoute = url.startsWith('/login') || url.startsWith('/register') || url === '/';
    const loggedIn = this.authService.isLoggedIn();
    this.shouldShowNav.set(loggedIn && !isUnprotectedRoute);
  }

  isRouteActive(path: string): boolean {
    const url = this.currentUrl();
    return url === path || url.startsWith(path);
  }
}
