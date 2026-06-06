import React from 'react';
import { Tooltip } from '@heroui/react';
import { useIsTouchDevice } from '../hooks/useIsTouchDevice';

type TooltipProps = React.ComponentProps<typeof Tooltip>;

// Drop-in replacement for HeroUI's Tooltip that disables itself on touch /
// hover-less devices. On mobile a hover tooltip opens on tap but never receives
// a mouseleave/blur, so it (and the trigger's highlight) gets stuck on screen.
export const HoverTooltip: React.FC<TooltipProps> = ({ isDisabled, ...props }) => {
  const isTouchDevice = useIsTouchDevice();
  return <Tooltip {...props} isDisabled={isDisabled || isTouchDevice} />;
};
