import { useEffect } from 'react';
import { App } from '@capacitor/app';
import { isAndroidPlatform } from '../utils/platform';

export function useBackButton(handler: () => void) {
  useEffect(() => {
    if (!isAndroidPlatform) return;
    
    // Capacitor's App plugin handles the hardware back button on Android
    const subscription = App.addListener('backButton', () => {
      // Execute the custom handler
      handler();
    });

    return () => {
      subscription.then(sub => sub.remove()).catch(console.error);
    };
  }, [handler]);
}
