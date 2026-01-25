import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  Easing,
} from 'remotion';
import { loadFont } from '@remotion/google-fonts/Montserrat';

interface LowerThirdProps {
  line1: string;
  line2: string;
}

const { fontFamily } = loadFont();

// Animated word with simple fade + slide - ENTRY ONLY
const AnimatedWord: React.FC<{
  word: string;
  delayIn: number;
  frame: number;
}> = ({ word, delayIn, frame }) => {
  // Entry animation only
  const progressIn = interpolate(frame - delayIn, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  const y = interpolate(progressIn, [0, 1], [15, 0]);
  const opacity = interpolate(progressIn, [0, 1], [0, 1]);

  return (
    <span
      style={{
        display: 'inline-block',
        opacity,
        transform: `translateY(${y}px)`,
        marginRight: 16,
      }}
    >
      {word}
    </span>
  );
};

export const LowerThird: React.FC<LowerThirdProps> = ({ line1, line2 = '' }) => {
  const frame = useCurrentFrame();

  // Handle empty line2
  const hasLine2 = line2 && line2.trim().length > 0;

  // Animation durations - ENTRY ONLY (no exit)
  const entryDuration = 20; // frames for entry animation

  // === BAR 1 (Red - slides from LEFT, stays in place) ===
  const bar1EntryProgress = interpolate(frame, [0, entryDuration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  const bar1X = interpolate(bar1EntryProgress, [0, 1], [-1200, 0]);

  const bar1Opacity = interpolate(frame, [0, 5], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // === BAR 2 (White - slides from RIGHT, stays in place) ===
  const bar2EntryProgress = interpolate(frame, [8, 8 + entryDuration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  const bar2X = interpolate(bar2EntryProgress, [0, 1], [1200, 0]);

  const bar2Opacity = interpolate(frame, [8, 13], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // === SABER EFFECT ===
  // Frames 20-70: rotate 360 degrees around the border
  // Frames 70-80: fade out and disappear
  const saberAngle = interpolate(frame, [20, 70], [0, 360], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const saberOpacity = interpolate(frame, [20, 25, 70, 80], [0, 0.8, 0.8, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Split words (handle empty strings)
  const words1 = line1 && line1.trim() ? line1.trim().split(' ') : [];
  const words2 = hasLine2 ? line2.trim().split(' ') : [];

  // Word animation delays - ENTRY ONLY
  const line1WordStartIn = 18;
  const line2WordStartIn = 26;

  // NO background - required for transparency
  return (
    <AbsoluteFill>
      {/* Main container */}
      <div
        style={{
          position: 'absolute',
          bottom: 40,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {/* Top bar - Red */}
        <div
          style={{
            transform: `translateX(${bar1X}px)`,
            opacity: bar1Opacity,
            position: 'relative',
          }}
        >
          {/* Saber line rotating around border - DISAPPEARS after full rotation */}
          {saberOpacity > 0 && (
            <div
              style={{
                position: 'absolute',
                top: -3,
                left: -3,
                right: -3,
                bottom: -3,
                borderRadius: 13,
                opacity: saberOpacity,
                background: `conic-gradient(from ${saberAngle}deg, transparent 0deg, transparent 330deg, #FF6666 345deg, #FFFFFF 355deg, #FF6666 360deg)`,
                WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                WebkitMaskComposite: 'xor',
                maskComposite: 'exclude',
                padding: 3,
                pointerEvents: 'none',
                filter: 'drop-shadow(0 0 6px #FF3333) drop-shadow(0 0 12px #FF0000)',
              }}
            />
          )}

          {/* Main red bar */}
          <div
            style={{
              background: 'linear-gradient(to top, #8B0000 0%, #CC0000 40%, #FF0000 100%)',
              padding: '18px 40px',
              borderRadius: 10,
              display: 'inline-flex',
              justifyContent: 'center',
              boxShadow: '0 6px 25px rgba(0,0,0,0.5)',
            }}
          >
            <div
              style={{
                fontFamily,
                fontSize: 46,
                fontWeight: 900,
                textTransform: 'uppercase',
                letterSpacing: '1px',
                whiteSpace: 'nowrap',
                display: 'flex',
                color: '#FFFFFF',
              }}
            >
              {words1.map((word, i) => (
                <AnimatedWord
                  key={i}
                  word={word}
                  delayIn={line1WordStartIn + i * 4}
                  frame={frame}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Bottom bar - White/Gray */}
        {hasLine2 && (
          <div
            style={{
              transform: `translateX(${bar2X}px)`,
              opacity: bar2Opacity,
              background: 'linear-gradient(to top, #666666 0%, #AAAAAA 30%, #FFFFFF 100%)',
              padding: '20px 50px',
              borderRadius: 10,
              display: 'inline-flex',
              justifyContent: 'center',
              boxShadow: '0 6px 25px rgba(0,0,0,0.4)',
            }}
          >
            <div
              style={{
                fontFamily,
                fontSize: 54,
                fontWeight: 900,
                textTransform: 'uppercase',
                letterSpacing: '1px',
                whiteSpace: 'nowrap',
                display: 'flex',
                color: '#111111',
              }}
            >
              {words2.map((word, i) => (
                <AnimatedWord
                  key={i}
                  word={word}
                  delayIn={line2WordStartIn + i * 4}
                  frame={frame}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

export default LowerThird;
