import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './login.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './login.scss',
})
export class LoginComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  email = signal('');
  password = signal('');
  isPasswordEnabled = signal(false);
  isLoading = signal(false);
  errorMessage = signal('');

  ngOnInit(): void {
    // Local-First: If user is already logged in, navigate straight to dashboard
    if (this.authService.isLoggedIn()) {
      this.router.navigate(['/dashboard']);
      return;
    }

    const savedUser = this.authService.getLocalUser();
    if (savedUser && savedUser.email) {
      this.email.set(savedUser.email);
      this.isPasswordEnabled.set(true);
    }
  }

  onSubmitEmail(): void {
    if (!this.email()) {
      this.errorMessage.set('Please enter your email.');
      return;
    }

    this.isLoading.set(true);
    this.errorMessage.set('');

    this.authService.checkEmail(this.email()).subscribe({
      next: (res) => {
        this.isLoading.set(false);
        if (res.exists) {
          this.isPasswordEnabled.set(true);
        } else {
          // User does not exist, navigate to register, prefilling email
          this.router.navigate(['/register'], { queryParams: { email: this.email() } });
        }
      },
      error: (err) => {
        this.isLoading.set(false);
        // Fall back gracefully to password prompt if user is logging in
        this.isPasswordEnabled.set(true);
      },
    });
  }

  onSubmitPassword(): void {
    if (!this.password()) {
      this.errorMessage.set('Please enter your password.');
      return;
    }

    this.isLoading.set(true);
    this.errorMessage.set('');

    this.authService.login(this.email(), this.password()).subscribe({
      next: (res) => {
        const userObj = {
          id: res.userid,
          email: this.email(),
          name: this.email().split('@')[0]
        };
        this.authService.setSession(res.userid, res.token, userObj);
        // Fetch user details ONCE on login to populate store
        this.authService.getUserDetails(res.userid, true).subscribe({
          next: () => {
            this.isLoading.set(false);
            this.router.navigate(['/dashboard']);
          },
          error: () => {
            this.isLoading.set(false);
            this.router.navigate(['/dashboard']);
          }
        });
      },
      error: (err) => {
        this.isLoading.set(false);

        // Strict auth rejection for HTTP 401 / 400 / 403 (e.g. Incorrect Password)
        if (err.status === 401 || err.status === 400 || err.status === 403) {
          const detail = err?.error?.detail || 'Incorrect password. Please try again.';
          this.errorMessage.set(detail);
          return;
        }

        // Network connection error / backend server offline fallback
        const savedUser = this.authService.getLocalUser();
        if (savedUser && savedUser.email && savedUser.email.toLowerCase() === this.email().trim().toLowerCase()) {
          this.authService.setSession(savedUser.id, 'local_token', savedUser);
          this.router.navigate(['/dashboard']);
        } else {
          this.errorMessage.set('Unable to connect to server. Please check your connection.');
        }
      },
    });
  }

  resetForm(): void {
    this.isPasswordEnabled.set(false);
    this.password.set('');
    this.errorMessage.set('');
  }
}
