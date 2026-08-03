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

  get apiUrl(): string {
    const customUrl = localStorage.getItem('API_URL');
    if (customUrl) {
      return customUrl.endsWith('/') ? customUrl.slice(0, -1) : customUrl;
    }
    return 'https://foodanalyzer-backend.onrender.com/api';
  }

  setBackendUrl(url: string): void {
    localStorage.setItem('API_URL', url);
  }

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

  getInferredLogs(userid: string, weekOffset: number = 0): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/users/${userid}/inferred-logs?week_offset=${weekOffset}`);
  }

  submitInferredFeedback(userid: string, payload: {
    date: string;
    time_period: string;
    description: string;
    feedback: string;
    time: string;
  }): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/users/${userid}/inferred-logs/feedback`, payload);
  }

  getRecommendations(userid: string, regenerate?: boolean): Observable<any> {
    const queryParam = regenerate ? '?regenerate=true' : '';
    return this.http.get<any>(`${this.apiUrl}/users/${userid}/recommendations${queryParam}`);
  }

  transcribeAudio(file: File | Blob): Observable<{ text: string }> {
    const formData = new FormData();
    formData.append('file', file, file instanceof File ? file.name : 'audio.wav');
    return this.http.post<{ text: string }>(`${this.apiUrl}/users/transcribe`, formData);
  }

  getRecommendationsStreamUrl(userid: string, regenerate?: boolean): string {
    const queryParam = regenerate ? '?regenerate=true' : '';
    return `${this.apiUrl}/users/${userid}/recommendations/stream${queryParam}`;
  }

  getStatelessRecommendationsStreamUrl(): string {
    return `${this.apiUrl}/recommendations/stream`;
  }

  getStatelessInferredMealsUrl(): string {
    return `${this.apiUrl}/inferred-meals`;
  }

  // Physical Activity & Analytics Graph Endpoints
  analyzeActivity(activityText: string): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/users/analyze-activity`, { activity_text: activityText });
  }

  addActivityLog(userid: string, payload: any): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/users/${userid}/activity-logs`, payload);
  }

  getActivityLogs(userid: string, weekOffset: number = 0): Observable<any[]> {
    return this.http.get<any[]>(`${this.apiUrl}/users/${userid}/activity-logs?week_offset=${weekOffset}`);
  }

  getDayOverview(userid: string, date: string): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/users/${userid}/day-overview?date=${date}`);
  }

  getGraphData(userid: string): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/users/${userid}/graph-data`);
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
