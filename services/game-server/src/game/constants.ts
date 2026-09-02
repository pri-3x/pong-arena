/**
 * Shared game constants. The SERVER is the source of truth for all of these;
 * the client only uses them to draw at the right scale.
 */
export const FIELD_W = 800;
export const FIELD_H = 480;

export const PADDLE_W = 12;
export const PADDLE_H = 80;
export const PADDLE_X = 24;          // distance of paddle from its wall
export const PADDLE_SPEED = 420;     // pixels per second

export const BALL_R = 8;
export const BALL_START_SPEED = 320; // pixels per second
export const BALL_SPEEDUP = 1.05;    // multiplier applied on every paddle hit
export const BALL_MAX_SPEED = 700;

export const WIN_SCORE = 5;

/** How often we advance the simulation. */
export const TICK_HZ = 60;
/** How often we send state to clients. Half the sim rate = half the bandwidth. */
export const BROADCAST_EVERY = 2;
