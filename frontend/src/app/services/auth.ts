import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface User {
  id: string;
  email: string;
  name?: string;
  userdetails?: string;
}

export interface CheckEmailResponse {
  exists: boolean;
  user?: User;
}

export interface LoginResponse {
  userid: string;
  token: string;
}

export interface RegisterResponse {
  userid: string;
  token: string;
  userdetails: string;
  placeholder?: string;
}

export interface UpdateDetailsResponse {
  userdetails: string;
  placeholder?: string;
}

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = 'http://localhost:8000/api';

  checkEmail(email: string): Observable<CheckEmailResponse> {
    return this.http.post<CheckEmailResponse>(`${this.apiUrl}/users/check`, { email });
  }

  getUserDetails(userid: string): Observable<User> {
    return this.http.get<User>(`${this.apiUrl}/users/${userid}`);
  }

  login(email: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.apiUrl}/users/login`, { email, password });
  }

  register(name: string, email: string, password: string, bio: string): Observable<RegisterResponse> {
    return this.http.post<RegisterResponse>(`${this.apiUrl}/users/register`, { name, email, password, bio });
  }

  confirmDetails(userid: string): Observable<any> {
    return this.http.post(`${this.apiUrl}/users/${userid}/confirm`, {});
  }

  updateDetails(userid: string, modifications: string): Observable<UpdateDetailsResponse> {
    return this.http.post<UpdateDetailsResponse>(`${this.apiUrl}/users/${userid}/update`, { modifications });
  }

  analyzeImage(file: File): Observable<any> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http.post<any>(`${this.apiUrl}/users/analyze-image`, formData);
  }

  analyzeFood(foodName: string): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/users/analyze-food`, { food_name: foodName });
  }

  addMealLog(userid: string, payload: any): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/users/${userid}/logs`, payload);
  }

  getMealLogs(userid: string, weekOffset: number = 0): Observable<any[]> {
    return this.http.get<any[]>(`${this.apiUrl}/users/${userid}/logs?week_offset=${weekOffset}`);
  }

  getRecommendations(userid: string): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/users/${userid}/recommendations`);
  }

  transcribeAudio(file: File | Blob): Observable<{ text: string }> {
    const formData = new FormData();
    formData.append('file', file, file instanceof File ? file.name : 'audio.wav');
    return this.http.post<{ text: string }>(`${this.apiUrl}/users/transcribe`, formData);
  }

  getRecommendationsStreamUrl(userid: string): string {
    return `${this.apiUrl}/users/${userid}/recommendations/stream`;
  }

  // LocalStorage Helpers
  setSession(userid: string, token: string): void {
    localStorage.setItem('userid', userid);
    localStorage.setItem('token', token);
  }

  getUserId(): string | null {
    return localStorage.getItem('userid');
  }

  getToken(): string | null {
    return localStorage.getItem('token');
  }

  isLoggedIn(): boolean {
    return !!this.getToken();
  }

  logout(): void {
    localStorage.removeItem('token');
  }

  clearSession(): void {
    localStorage.removeItem('userid');
    localStorage.removeItem('token');
  }
}
