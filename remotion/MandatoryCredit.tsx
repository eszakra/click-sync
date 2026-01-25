import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  Easing,
} from 'remotion';
import { loadFont } from '@remotion/google-fonts/Montserrat';

interface MandatoryCreditProps {
  text: string;
}

const { fontFamily } = loadFont();

export const MandatoryCredit: React.FC<MandatoryCreditProps> = ({ text }) => {
  const frame = useCurrentFrame();

  // Animation timing - ENTRY ONLY (no exit animation)
  const entryDuration = 18; // frames for entry animation

  // === BAR ANIMATION (slides from LEFT, stays in place) ===
  const barEntryProgress = interpolate(frame, [0, entryDuration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  const barX = interpolate(barEntryProgress, [0, 1], [-400, 0]);

  // Opacity - fade in only
  const barOpacity = interpolate(frame, [0, 5], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // === TEXT ANIMATION (fade in with slight delay, then stay) ===
  const textEntryProgress = interpolate(frame, [8, 8 + 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  const textOpacity = interpolate(textEntryProgress, [0, 1], [0, 1]);
  const textY = interpolate(textEntryProgress, [0, 1], [8, 0]);

  // Red accent line animation - grows on entry, stays at full width
  const accentWidth = interpolate(frame, [5, 20], [0, 4], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  return (
    <AbsoluteFill>
      {/* Main container - top left */}
      <div
        style={{
          position: 'absolute',
          top: 30,
          left: 30,
          transform: `translateX(${barX}px)`,
          opacity: barOpacity,
          display: 'flex',
          alignItems: 'stretch',
        }}
      >
        {/* Red accent line on left side - matches lower third brand */}
        <div
          style={{
            width: accentWidth,
            background: 'linear-gradient(to bottom, #FF0000 0%, #CC0000 100%)',
            borderRadius: '3px 0 0 3px',
          }}
        />

        {/* Main dark bar */}
        <div
          style={{
            background: 'linear-gradient(to bottom, rgba(30, 30, 30, 0.95) 0%, rgba(15, 15, 15, 0.98) 100%)',
            padding: '10px 20px 10px 16px',
            borderRadius: '0 6px 6px 0',
            boxShadow: '0 4px 15px rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontFamily,
              fontSize: 22,
              fontWeight: 300, // Light weight for elegant look
              letterSpacing: '0.5px',
              color: '#FFFFFF',
              whiteSpace: 'nowrap',
              opacity: textOpacity,
              transform: `translateY(${textY}px)`,
            }}
          >
            {text}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default MandatoryCredit;
