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
    // If token is already present, they are logged in, send them to dashboard
    if (this.authService.isLoggedIn()) {
      this.router.navigate(['/dashboard']);
      return;
    }

    const savedUserId = this.authService.getUserId();
    if (savedUserId) {
      this.isLoading.set(true);
      this.authService.getUserDetails(savedUserId).subscribe({
        next: (user) => {
          this.email.set(user.email);
          this.isPasswordEnabled.set(true);
          this.isLoading.set(false);
        },
        error: (err) => {
          // Clear invalid localStorage
          this.authService.clearSession();
          this.isLoading.set(false);
        },
      });
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
        this.errorMessage.set('An error occurred. Please try again.');
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
        this.authService.setSession(res.userid, res.token);
        this.isLoading.set(false);
        this.router.navigate(['/dashboard']);
      },
      error: (err) => {
        this.isLoading.set(false);
        this.errorMessage.set(err.error?.detail || 'Incorrect password.');
      },
    });
  }

  resetForm(): void {
    this.isPasswordEnabled.set(false);
    this.password.set('');
    this.errorMessage.set('');
  }
}
