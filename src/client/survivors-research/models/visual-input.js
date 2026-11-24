import { ResearchModelError } from './common.js';

export const VISUAL_WIDTH = 480;
export const VISUAL_HEIGHT = 270;
export const MAX_VISUAL_IMAGE_BYTES = 96 * 1024;
export const MAX_VISUAL_BASE64_LENGTH = Math.ceil(MAX_VISUAL_IMAGE_BYTES / 3) * 4;
const IMAGE_PROFILES = ['structured-v1', 'schematic-v1', 'full-v1'];
export const VISUAL_PROFILES = Object.freeze(['none-v1', ...IMAGE_PROFILES]);
export const LOCAL_MICRO_PROFILE = 'local-micro-v1';
export const STRUCTURED_NEAR_PROFILE = 'structured-near-v1';
export const STRUCTURED_TRAIL_PROFILE = 'structured-trail-v1';
export const TRAJECTORY_PROFILE = 'trajectory-v1';
export const EVIDENCE_VISUAL_PROFILES = Object.freeze([...VISUAL_PROFILES, TRAJECTORY_PROFILE, STRUCTURED_NEAR_PROFILE, STRUCTURED_TRAIL_PROFILE, LOCAL_MICRO_PROFILE]);
export const VISUAL_IMAGE_REFERENCE = 'mundi-research-image:v1';
export const STRUCTURED_IMAGE_LEGEND = 'In the structured image, the near-white diamond at the center is the only player you control. When visible, the amber chevron above the player shows current left or right facing. The thin white line shows movement. Moving vertically or stopping retains the last horizontal facing. Green diamonds are experience gems. Pink or red circles are enemies. Image directions match the movement actions: right is +x, down is +y, and positions are relative to your player.';
export const STRUCTURED_NEAR_IMAGE_LEGEND = STRUCTURED_IMAGE_LEGEND +
  ' The near view uses 30 pixels per world unit and covers relative x from -8 to +8 and y from -4.5 to +4.5.';
export const STRUCTURED_TRAIL_LEGEND_SUFFIX = 'The thin purple trail shows your actual movement over the last two seconds of simulated time, or since this run started if shorter. It ends at the player and shows no future movement.';
export const STRUCTURED_TRAIL_IMAGE_LEGEND = STRUCTURED_IMAGE_LEGEND + ' ' + STRUCTURED_TRAIL_LEGEND_SUFFIX;

function invalidImage(message) {
  return new ResearchModelError('invalid_visual_input', message);
}

export function validateVisualImage(image, observationTick, profile = image?.profile) {
  if (!image || profile === 'none-v1' || !EVIDENCE_VISUAL_PROFILES.includes(profile) || image.profile !== profile ||
      !Number.isSafeInteger(observationTick) || observationTick < 0 || image.tick !== observationTick ||
      Object.keys(image).length !== 4 || !['image/png', 'image/jpeg'].includes(image.mime_type) ||
      ([TRAJECTORY_PROFILE,LOCAL_MICRO_PROFILE].includes(profile) && image.mime_type !== 'image/png') || typeof image.data_url !== 'string') {
    throw invalidImage('Expected one image matching the observation tick and visual profile');
  }
  const prefix = 'data:' + image.mime_type + ';base64,';
  if (!image.data_url.startsWith(prefix) || image.data_url.length > prefix.length + MAX_VISUAL_BASE64_LENGTH) {
    throw invalidImage('Image must be an inline PNG or JPEG within the byte limit');
  }
  const encoded = image.data_url.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw invalidImage('Image data URL must use canonical base64');
  }
  const decoded = atob(encoded);
  if (decoded.length > MAX_VISUAL_IMAGE_BYTES || btoa(decoded) !== encoded) {
    throw invalidImage('Image encoding is invalid or exceeds the byte limit');
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < bytes.length; index++) bytes[index] = decoded.charCodeAt(index);
  const dimensions = image.mime_type === 'image/png' ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!dimensions || dimensions.width !== VISUAL_WIDTH || dimensions.height !== VISUAL_HEIGHT) {
    throw invalidImage('Image format or viewport dimensions do not match the research protocol');
  }
  return {
    profile, tick: observationTick, mime_type: image.mime_type, ...dimensions, byte_length: bytes.length,
  };
}

function pngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || !signature.every((byte, index) => bytes[index] === byte)) return null;
  const view = new DataView(bytes.buffer);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null; // IHDR
  let offset = 33;
  let hasImage = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    offset += length + 12;
    if (offset > bytes.length) return null;
    if (type === 0x49444154 && length > 0) hasImage = true; // IDAT
    if (type === 0x49454e44) { // IEND
      return hasImage && length === 0 && offset === bytes.length
        ? { width: view.getUint32(16), height: view.getUint32(20) }
        : null;
    }
    if ([0x6163544c, 0x6663544c, 0x66644154].includes(type)) return null; // APNG chunks
  }
  return null;
}

function jpegDimensions(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer);
  let offset = 2;
  let dimensions;
  let scanning = false;
  let hasScan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) {
      if (!scanning) return null;
      continue;
    }
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (scanning && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    scanning = false;
    if (marker === 0xd9) return hasScan && offset === bytes.length ? dimensions : null;
    if (marker === 0xd8 || marker === 0 || offset + 2 > bytes.length) return null;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (dimensions || length < 11 || bytes[offset + 2] !== 8) return null;
      dimensions = { height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) };
    } else if (marker === 0xda) {
      if (!dimensions || length < 6) return null;
      scanning = true;
      hasScan = true;
    }
    offset += length;
  }
  return null;
}
