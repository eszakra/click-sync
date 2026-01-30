import React from 'react';
import { Composition } from 'remotion';
import { LowerThird } from './LowerThird';
import { MandatoryCredit } from './MandatoryCredit';

// Props interface for the composition
interface LowerThirdCompositionProps {
    line1: string;
    line2: string;
    durationInSeconds?: number;
}

// Props interface for mandatory credit
interface MandatoryCreditCompositionProps {
    text: string;
    durationInSeconds?: number;
}

// Wrapper component for mandatory credit
const MandatoryCreditComposition: React.FC<MandatoryCreditCompositionProps> = ({ text }) => {
    return (
        <MandatoryCredit text={text} />
    );
};

// Wrapper component for the composition
const LowerThirdComposition: React.FC<LowerThirdCompositionProps> = ({ line1, line2 }) => {
    return (
        <LowerThird
            line1={line1}
            line2={line2}
        />
    );
};

export const RemotionRoot: React.FC = () => {
    return (
        <>
            {/* Lower Third Overlay - Transparent background for compositing */}
            <Composition
                id="LowerThird"
                component={LowerThirdComposition}
                durationInFrames={80}
                fps={30}
                width={1920}
                height={1080}
                defaultProps={{
                    line1: "HEADLINE TEXT HERE",
                    line2: 'SUBTITLE TEXT HERE',
                    durationInSeconds: 3,
                }}
            />

            {/* Segment Lower Third - Duration based on segment props */}
            <Composition
                id="SegmentLowerThird"
                component={LowerThirdComposition}
                durationInFrames={80}
                fps={30}
                width={1920}
                height={1080}
                defaultProps={{
                    line1: "HEADLINE LINE 1",
                    line2: 'HEADLINE LINE 2',
                    durationInSeconds: 3,
                }}
                calculateMetadata={({ props }) => {
                    // Calculate frames based on duration, minimum 80 frames (~2.67 seconds) for animation
                    const frames = Math.max(80, Math.round((props.durationInSeconds || 3) * 30));
                    return {
                        durationInFrames: frames,
                    };
                }}
            />

            {/* Mandatory Credit - Top left corner overlay */}
            <Composition
                id="MandatoryCredit"
                component={MandatoryCreditComposition}
                durationInFrames={30}
                fps={30}
                width={1920}
                height={1080}
                defaultProps={{
                    text: "World Economic Forum",
                    durationInSeconds: 3,
                }}
            />

            {/* Segment Mandatory Credit - Duration based on segment props */}
            <Composition
                id="SegmentMandatoryCredit"
                component={MandatoryCreditComposition}
                durationInFrames={30}
                fps={30}
                width={1920}
                height={1080}
                defaultProps={{
                    text: "Source Credit Here",
                    durationInSeconds: 3,
                }}
                calculateMetadata={({ props }) => {
                    const frames = Math.max(30, Math.round((props.durationInSeconds || 1) * 30));
                    return {
                        durationInFrames: frames,
                    };
                }}
            />
        </>
    );
};
