import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.foodanalyzer.app',
  appName: 'FoodAnalyzer',
  webDir: 'dist/frontend-app/browser',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    GoogleAuth: {
      scopes: ['profile', 'email', 'openid'],
      serverClientId: '982629775401-rd59t87e32pf2hhutg4jgs6ncem72cbr.apps.googleusercontent.com',
      forceCodeForRefreshToken: true
    }
  }
};

export default config;
