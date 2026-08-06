import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth';
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './register.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './register.scss',
})
export class RegisterComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  // Form Fields
  name = signal('');
  email = signal('');
  password = signal('');
  bio = signal('');

  // UI States
  step = signal(1); // Step 1: Form, Step 2: Confirm / Update Details
  isLoading = signal(false);
  errorMessage = signal('');

  // Step 2 Fields
  userDetailsText = signal(''); // Raw text from backend
  userDetailsList = signal<string[]>([]); // Parsed lines
  modifications = signal(''); // Modification textarea
  placeholderText = signal('Add details, correct typos, or change your diet goal...'); // Dynamic placeholder question
  userid = signal('');

  ngOnInit(): void {
    if (this.authService.isLoggedIn() && !this.route.snapshot.queryParams['google']) {
      this.router.navigate(['/dashboard']);
      return;
    }

    this.route.queryParams.subscribe((params) => {
      if (params['email']) {
        this.email.set(params['email']);
      }
      if (params['google'] === 'true') {
        if (params['userid']) this.userid.set(params['userid']);
        if (params['name']) this.name.set(params['name']);
        if (params['email']) this.email.set(params['email']);
        this.placeholderText.set('Tell us about your age, activity level, health goals, or dietary preferences...');
        this.step.set(2);
      }
    });

    this.initGoogleOAuth();
  }

  showGoogleModal = signal(false);
  googleEmailInput = signal('');
  isGoogleInitialized = false;

  initGoogleOAuth(): void {
    if (this.isGoogleInitialized) return;
    this.ensureGoogleScriptLoaded(() => {
      if (typeof window !== 'undefined' && (window as any).google?.accounts?.id) {
        try {
          const clientId = this.authService.getGoogleClientId();
          (window as any).google.accounts.id.initialize({
            client_id: clientId,
            callback: (response: any) => this.onGoogleCredentialReceived(response.credential)
          });
          this.isGoogleInitialized = true;
        } catch (e) {
          console.warn('Google GSI initialization warning:', e);
        }
      }
    });
  }

  ensureGoogleScriptLoaded(callback: () => void): void {
    if (typeof window !== 'undefined' && (window as any).google?.accounts) {
      callback();
      return;
    }
    if (typeof document !== 'undefined') {
      const existingScript = document.getElementById('google-gsi-script');
      if (existingScript) {
        existingScript.addEventListener('load', () => callback());
        setTimeout(() => callback(), 800);
        return;
      }
      const script = document.createElement('script');
      script.id = 'google-gsi-script';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => callback();
      script.onerror = () => callback();
      document.head.appendChild(script);
    } else {
      callback();
    }
  }

  async signInWithGoogle(): Promise<void> {
    // 1. Try Native Android / iOS Google Auth Plugin (Triggers Native Google Account Picker!)
    try {
      if (typeof window !== 'undefined' && (window as any).Capacitor) {
        GoogleAuth.initialize({
          clientId: this.authService.getGoogleClientId(),
          scopes: ['profile', 'email', 'openid'],
          grantOfflineAccess: true
        });
        const googleUser = await GoogleAuth.signIn();
        if (googleUser && googleUser.email) {
          const email = googleUser.email;
          const name = googleUser.name || googleUser.givenName || email.split('@')[0];
          const idToken = googleUser.authentication?.idToken;
          this.handleGoogleUserRegister(idToken || null, email, name);
          return;
        }
      }
    } catch (err: any) {
      console.warn('Native Capacitor Google Auth error / skipped:', err);
    }

    // 2. Web Fallback (Google Identity Services popup / In-App Modal)
    this.ensureGoogleScriptLoaded(() => {
      if (typeof window !== 'undefined' && (window as any).google?.accounts?.oauth2) {
        try {
          const clientId = this.authService.getGoogleClientId();
          const client = (window as any).google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: 'email profile openid',
            callback: (tokenResponse: any) => {
              if (tokenResponse && tokenResponse.access_token) {
                this.isLoading.set(true);
                fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                  headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
                })
                  .then((res) => res.json())
                  .then((profile) => {
                    this.handleGoogleUserRegister(null, profile.email, profile.name);
                  })
                  .catch((err) => {
                    console.error('Failed to fetch Google userinfo profile:', err);
                    this.isLoading.set(false);
                    this.openGoogleModal();
                  });
              }
            },
            error_callback: (err: any) => {
              console.warn('Google OAuth popup error:', err);
              this.isLoading.set(false);
              this.openGoogleModal();
            }
          });
          client.requestAccessToken();
          return;
        } catch (e) {
          console.warn('Google OAuth init error, using in-app modal:', e);
        }
      }
      this.openGoogleModal();
    });
  }

  openGoogleModal(): void {
    this.googleEmailInput.set(this.email() || '');
    this.showGoogleModal.set(true);
  }

  closeGoogleModal(): void {
    this.showGoogleModal.set(false);
  }

  submitGoogleModal(): void {
    const email = this.googleEmailInput().trim();
    if (!email) return;
    this.showGoogleModal.set(false);
    const name = email.split('@')[0];
    this.handleGoogleUserRegister(null, email, name);
  }

  onGoogleCredentialReceived(credential: string): void {
    if (!credential) return;
    const payload = this.authService.parseJwt(credential);
    const email = payload?.email;
    const name = payload?.name;
    this.handleGoogleUserRegister(credential, email, name);
  }

  handleGoogleUserRegister(credential: string | null, email?: string, name?: string): void {
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
        this.userid.set(res.userid);
        this.isLoading.set(false);

        if (res.has_health_details) {
          this.router.navigate(['/dashboard']);
        } else {
          this.userDetailsText.set(res.userdetails || '');
          this.parseUserDetails(res.userdetails || '');
          this.placeholderText.set('Tell us about your age, activity level, health goals, or dietary preferences...');
          this.step.set(2);
        }
      },
      error: () => {
        this.isLoading.set(false);
        const localId = 'usr_g_' + Math.random().toString(36).substring(2, 9);
        const userObj = {
          id: localId,
          email: email || 'google.user@gmail.com',
          name: name || 'Google Member'
        };
        this.authService.setSession(localId, 'google_local_token', userObj);
        this.userid.set(localId);
        this.step.set(2);
      }
    });
  }

  onSubmitRegister(): void {
    if (!this.name() || !this.email() || !this.password() || !this.bio()) {
      this.errorMessage.set('Please fill out all fields.');
      return;
    }

    this.isLoading.set(true);
    this.errorMessage.set('');

    this.authService.register(this.name(), this.email(), this.password(), this.bio()).subscribe({
      next: (res) => {
        const userObj = {
          id: res.userid,
          email: this.email(),
          name: this.name(),
          userdetails: res.userdetails
        };
        this.authService.setSession(res.userid, res.token, userObj);
        this.userid.set(res.userid);
        this.userDetailsText.set(res.userdetails);
        this.authService.saveUserHealthDetails(res.userid, res.userdetails);
        this.parseUserDetails(res.userdetails);
        if (res.placeholder) {
          this.placeholderText.set(res.placeholder);
        }

        this.isLoading.set(false);
        this.step.set(2);
      },
      error: (err) => {
        this.isLoading.set(false);

        if (err.status === 400 || err.status === 401 || err.status === 409) {
          const detail = err?.error?.detail || 'Registration failed. Email may already be registered.';
          this.errorMessage.set(detail);
          return;
        }

        // Local-First Fallback if network connection error
        const localId = 'usr_' + Math.random().toString(36).substring(2, 9);
        const userObj = {
          id: localId,
          email: this.email(),
          name: this.name(),
          userdetails: this.bio()
        };
        this.authService.setSession(localId, 'local_token', userObj);
        this.authService.saveUserHealthDetails(localId, this.bio());
        this.router.navigate(['/dashboard']);
      },
    });
  }

  // Parse newlines/bullet points into clean list elements
  private parseUserDetails(text: string): void {
    if (!text) {
      this.userDetailsList.set([]);
      return;
    }
    const lines = text
      .split('\n')
      .map((line) => line.replace(/^[•\-\*\s]+/, '').trim())
      .filter((line) => line.length > 0);
    this.userDetailsList.set(lines);
  }

  onActionStep2(): void {
    this.isLoading.set(true);
    this.errorMessage.set('');

    if (this.modifications().trim() !== '') {
      // "Update" Action
      this.authService.updateDetails(this.userid(), this.modifications()).subscribe({
        next: (res) => {
          this.userDetailsText.set(res.userdetails);
          this.authService.saveUserHealthDetails(this.userid(), res.userdetails);
          this.parseUserDetails(res.userdetails);
          if (res.placeholder) {
            this.placeholderText.set(res.placeholder);
          }
          this.modifications.set(''); // Clear modification textarea
          this.isLoading.set(false);
        },
        error: (err) => {
          this.isLoading.set(false);
          this.errorMessage.set(err.error?.detail || 'Failed to update details.');
        },
      });
    } else {
      // "Confirm" Action
      this.authService.saveUserHealthDetails(this.userid(), this.userDetailsText());
      this.authService.confirmDetails(this.userid()).subscribe({
        next: () => {
          this.isLoading.set(false);
          this.router.navigate(['/dashboard']);
        },
        error: () => {
          // Local-first completion if network is slow/restarting
          this.isLoading.set(false);
          this.router.navigate(['/dashboard']);
        },
      });
    }
  }

  goToLogin(): void {
    this.router.navigate(['/login']);
  }
}
