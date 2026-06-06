import React from 'react';

// Detects touch / hover-less devices so we can disable hover-only affordances
// (e.g. tooltips) that otherwise get stuck open after a tap on mobile.
const TOUCH_QUERY = '(hover: none), (pointer: coarse)';

export const useIsTouchDevice = (): boolean => {
  const getMatch = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(TOUCH_QUERY).matches;
  };

  const [isTouch, setIsTouch] = React.useState<boolean>(getMatch);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQuery = window.matchMedia(TOUCH_QUERY);
    const handleChange = () => setIsTouch(mediaQuery.matches);
    handleChange();

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isTouch;
};
