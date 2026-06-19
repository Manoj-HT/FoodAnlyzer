import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../services/auth';

@Component({
  selector: 'app-navigation',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './navigation.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './navigation.scss',
})
export class NavigationComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  userName = signal('Member');

  ngOnInit(): void {
    const userid = this.authService.getUserId();
    if (userid) {
      this.authService.getUserDetails(userid).subscribe({
        next: (user) => {
          this.userName.set(user.name || 'Member');
        },
        error: (err) => {
          console.error('Failed to load user details in header:', err);
        },
      });
    }
  }

  onLogout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
