// Shared by the reader's modules: angles, the reading pitch, a turn's length, and scratch vectors (one frame's use).
import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const READ_PITCH = -22 * DEG;
export const TURN_DUR = 0.82;

export const _v = new THREE.Vector3();
export const _q = new THREE.Quaternion();
export const _e = new THREE.Euler();
export const _m = new THREE.Matrix4();
export const _P = new THREE.Vector3();
export const _T = new THREE.Vector3();
export const _U = new THREE.Vector3();
export const _N = new THREE.Vector3();
export const _w = new THREE.Vector3();
