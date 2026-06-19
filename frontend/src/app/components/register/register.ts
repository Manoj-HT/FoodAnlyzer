import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth';

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
    if (this.authService.isLoggedIn()) {
      this.router.navigate(['/dashboard']);
      return;
    }

    // Prefill email from query parameters
    this.route.queryParams.subscribe((params) => {
      if (params['email']) {
        this.email.set(params['email']);
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
        this.authService.setSession(res.userid, res.token);
        this.userid.set(res.userid);
        this.userDetailsText.set(res.userdetails);
        this.parseUserDetails(res.userdetails);
        if (res.placeholder) {
          this.placeholderText.set(res.placeholder);
        }

        this.isLoading.set(false);
        this.step.set(2);
      },
      error: (err) => {
        this.isLoading.set(false);
        this.errorMessage.set(err.error?.detail || 'Registration failed. Try again.');
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
      this.authService.confirmDetails(this.userid()).subscribe({
        next: () => {
          this.isLoading.set(false);
          this.router.navigate(['/dashboard']);
        },
        error: (err) => {
          this.isLoading.set(false);
          this.errorMessage.set(err.error?.detail || 'Failed to confirm details.');
        },
      });
    }
  }

  goToLogin(): void {
    this.router.navigate(['/login']);
  }
}
