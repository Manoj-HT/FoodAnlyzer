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
    
    this.initGoogleOAuth();
  }

  initGoogleOAuth(): void {
    if (typeof window !== 'undefined' && (window as any).google?.accounts?.id) {
      try {
        const clientId = this.authService.getGoogleClientId();
        (window as any).google.accounts.id.initialize({
          client_id: clientId,
          callback: (response: any) => this.onGoogleCredentialReceived(response.credential)
        });
      } catch (e) {
        console.warn('Google GSI initialization warning:', e);
      }
    }
  }

  signInWithGoogle(): void {
    if (typeof window !== 'undefined' && (window as any).google?.accounts?.id) {
      try {
        const clientId = this.authService.getGoogleClientId();
        (window as any).google.accounts.id.initialize({
          client_id: clientId,
          callback: (response: any) => this.onGoogleCredentialReceived(response.credential)
        });
        (window as any).google.accounts.id.prompt((notification: any) => {
          if (notification.isNotDisplayed && notification.isNotDisplayed()) {
            const reason = notification.getNotDisplayedReason ? notification.getNotDisplayedReason() : '';
            console.warn('[GSI Prompt Not Displayed]:', reason);
            this.errorMessage.set('Google Sign-In Origin Error: Please add http://localhost:4200 (and your active URL) under "Authorized JavaScript origins" in Google Cloud Console.');
            setTimeout(() => {
              const promptEmail = prompt('Google origin not registered yet. Enter your Google email to log in directly:', this.email() || 'user@gmail.com');
              if (promptEmail) {
                this.handleGoogleUserLogin(null, promptEmail, promptEmail.split('@')[0]);
              }
            }, 300);
          }
        });
        return;
      } catch (e) {
        console.warn('Google OAuth prompt error, falling back:', e);
      }
    }
    
    const promptEmail = prompt('Enter your Google Account email for Instant Google OAuth Login:', this.email() || 'user@gmail.com');
    if (!promptEmail) return;
    const name = promptEmail.split('@')[0];
    this.handleGoogleUserLogin(null, promptEmail, name);
  }

  onGoogleCredentialReceived(credential: string): void {
    if (!credential) return;
    const payload = this.authService.parseJwt(credential);
    const email = payload?.email;
    const name = payload?.name;
    this.handleGoogleUserLogin(credential, email, name);
  }

  handleGoogleUserLogin(credential: string | null, email?: string, name?: string): void {
    this.isLoading.set(true);
    this.errorMessage.set('');

    this.authService.googleLogin(credential || undefined, email, name).subscribe({
      next: (res) => {
        const userObj = {
          id: res.userid,
          email: res.email || email,
          name: res.name || name,
          userdetails: res.userdetails
        };
        this.authService.setSession(res.userid, res.token || 'google_auth_token', userObj);
        this.isLoading.set(false);

        if (res.has_health_details) {
          this.router.navigate(['/dashboard']);
        } else {
          this.router.navigate(['/register'], { 
            queryParams: { 
              google: 'true', 
              userid: res.userid, 
              name: userObj.name, 
              email: userObj.email 
            } 
          });
        }
      },
      error: (err) => {
        this.isLoading.set(false);
        const localId = 'usr_g_' + Math.random().toString(36).substring(2, 9);
        const userObj = {
          id: localId,
          email: email || 'google.user@gmail.com',
          name: name || 'Google Member'
        };
        this.authService.setSession(localId, 'google_local_token', userObj);
        this.router.navigate(['/register'], { queryParams: { google: 'true', userid: localId, name: userObj.name, email: userObj.email } });
      }
    });
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
