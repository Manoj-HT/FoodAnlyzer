import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, tap } from 'rxjs';

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
    return 'https://foodanalyzer-backend-sgh5.onrender.com/api';
  }

  setBackendUrl(url: string): void {
    localStorage.setItem('API_URL', url);
  }

  getGoogleClientId(): string {
    return localStorage.getItem('GOOGLE_CLIENT_ID') || '982629775401-rd59t87e32pf2hhutg4jgs6ncem72cbr.apps.googleusercontent.com';
  }

  currentUser = signal<User | null>(this.getLocalUser());
  private userDetailsObservable: Observable<User> | null = null;

  checkEmail(email: string): Observable<CheckEmailResponse> {
    return this.http.post<CheckEmailResponse>(`${this.apiUrl}/users/check`, { email });
  }

  saveUserHealthDetails(userid: string, userdetails: string): void {
    if (!userid || !userdetails) return;
    try {
      localStorage.setItem(`health_details_${userid}`, userdetails);
      const current = this.currentUser() || this.getLocalUser();
      if (current && (current.id === userid || !current.id)) {
        const updated = { ...current, id: userid, userdetails };
        this.saveLocalUser(updated);
      }
    } catch (e) {
      console.error('Failed to save health details to device:', e);
    }
  }

  getUserHealthDetails(userid: string): string | null {
    if (!userid) return null;
    try {
      const localDetails = localStorage.getItem(`health_details_${userid}`);
      if (localDetails) return localDetails;
    } catch (e) {
      console.error('Failed to read device health details:', e);
    }
    const current = this.currentUser() || this.getLocalUser();
    if (current && current.userdetails) {
      return current.userdetails;
    }
    return null;
  }

  getUserDetails(userid: string, forceRefresh = false): Observable<User> {
    const deviceDetails = this.getUserHealthDetails(userid);
    const cached = this.currentUser();
    
    if (!forceRefresh && cached && cached.id === userid && cached.userdetails) {
      return of(cached);
    }

    if (this.userDetailsObservable && !forceRefresh) {
      return this.userDetailsObservable;
    }

    this.userDetailsObservable = this.http.get<User>(`${this.apiUrl}/users/${userid}`).pipe(
      tap({
        next: (user) => {
          if (deviceDetails && !user.userdetails) {
            user.userdetails = deviceDetails;
          } else if (user.userdetails) {
            this.saveUserHealthDetails(userid, user.userdetails);
          }
          this.currentUser.set(user);
          this.saveLocalUser(user);
          this.userDetailsObservable = null;
        },
        error: () => {
          this.userDetailsObservable = null;
          const fallbackUser: User = cached || {
            id: userid,
            email: 'user@local.app',
            name: 'Member',
            userdetails: deviceDetails || ''
          };
          if (deviceDetails) fallbackUser.userdetails = deviceDetails;
          this.currentUser.set(fallbackUser);
          this.saveLocalUser(fallbackUser);
          return of(fallbackUser);
        },
      })
    );

    return this.userDetailsObservable;
  }

  login(email: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.apiUrl}/users/login`, { email, password });
  }

  googleLogin(credential?: string, email?: string, name?: string): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/users/google-login`, { credential, email, name });
  }

  parseJwt(token: string): any {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(jsonPayload);
    } catch (e) {
      console.error('Failed to parse JWT token:', e);
      return null;
    }
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

  getUnifiedLogs(userid: string, weekOffset: number = 0): Observable<{
    food_logs: any[];
    activity_logs: any[];
    inferred_logs: any[];
    low_data: boolean;
  }> {
    return this.http.get<any>(`${this.apiUrl}/users/${userid}/unified-logs?week_offset=${weekOffset}`);
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
    let filename = 'audio.wav';
    if (file instanceof File) {
      filename = file.name;
    } else {
      const type = file.type || 'audio/webm';
      if (type.includes('webm')) filename = 'audio.webm';
      else if (type.includes('mp4') || type.includes('m4a')) filename = 'audio.m4a';
      else if (type.includes('ogg')) filename = 'audio.ogg';
      else if (type.includes('3gpp')) filename = 'audio.3gp';
    }
    formData.append('file', file, filename);
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

  // LocalStorage & Offline Local-First Profile Helpers
  setSession(userid: string, token: string, user?: User): void {
    localStorage.setItem('userid', userid);
    localStorage.setItem('token', token);
    if (user) {
      this.saveLocalUser(user);
    }
  }

  saveLocalUser(user: User): void {
    try {
      localStorage.setItem('user_profile', JSON.stringify(user));
      this.currentUser.set(user);
    } catch (e) {
      console.error('Failed to save local user profile:', e);
    }
  }

  getLocalUser(): User | null {
    try {
      const data = localStorage.getItem('user_profile');
      if (data) {
        return JSON.parse(data) as User;
      }
    } catch (e) {
      console.error('Failed to parse local user profile:', e);
    }
    const uid = this.getUserId();
    if (uid) {
      return { id: uid, email: 'user@local.app', name: 'Member' };
    }
    return null;
  }

  getUserId(): string | null {
    return localStorage.getItem('userid');
  }

  getToken(): string | null {
    return localStorage.getItem('token');
  }

  isLoggedIn(): boolean {
    const userid = this.getUserId();
    const token = this.getToken();
    return !!userid && !!token;
  }

  logout(): void {
    this.clearSession();
  }

  clearSession(): void {
    localStorage.removeItem('userid');
    localStorage.removeItem('token');
    localStorage.removeItem('user_profile');
    localStorage.removeItem('cached_recommendations_stream');
    localStorage.removeItem('cached_graph_data');
    localStorage.removeItem('cached_day_overviews');
    for (let w = 0; w <= 3; w++) {
      localStorage.removeItem(`cached_unified_logs_week_${w}`);
    }
    this.currentUser.set(null);
  }
}
