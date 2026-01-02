/**
 * VETUU — Sprite Manager
 * Handles SVG sprite generation and management.
 */

// The base pixel data from cpt.svg (excluding the white background)
const CPT_PIXELS = [
  // Body/Details
  {x:12,y:0,w:1,h:1,c:"#63371C"},{x:11,y:0,w:1,h:1,c:"#63371C"},{x:10,y:0,w:1,h:1,c:"#63371C"},
  {x:10,y:1,w:1,h:1,c:"#63371C"},{x:11,y:1,w:1,h:1,c:"#DBD2D3"},{x:12,y:1,w:1,h:1,c:"#DBD2D3"},
  {x:11,y:2,w:1,h:1,c:"#FEFDFB"},{x:10,y:2,w:1,h:1,c:"#63371C"},{x:12,y:2,w:1,h:1,c:"#FFC17A"},
  {x:12,y:3,w:1,h:1,c:"#FFC17A"},{x:11,y:3,w:1,h:1,c:"#FFC17A"},{x:10,y:3,w:1,h:1,c:"#CB7946"},
  {x:12,y:4,w:1,h:1,c:"#FFC17A"},{x:11,y:4,w:1,h:1,c:"#FFC17A"},{x:10,y:4,w:1,h:1,c:"#CB7946"},
  {x:12,y:5,w:1,h:1,c:"#7C3F20"},{x:11,y:5,w:1,h:1,c:"#7C3F20"},{x:10,y:5,w:1,h:1,c:"#7C3F20"},
  {x:12,y:6,w:1,h:1,c:"#9E7C59"},{x:11,y:6,w:1,h:1,c:"#9E7C59"},{x:10,y:6,w:1,h:1,c:"#524326"},
  {x:13,y:6,w:1,h:1,c:"#2E5552"},{x:9,y:6,w:1,h:1,c:"#524326"},
  
  // Head/Shoulders Area
  {x:10,y:7,w:1,h:1,c:"#524326"},{x:11,y:7,w:1,h:1,c:"#B9A396"},
  {x:9,y:7,w:1,h:1,c:"#837D7D"},{x:15,y:7,w:1,h:1,c:"#837D7D"},{x:8,y:7,w:1,h:1,c:"#837D7D"},
  {x:14,y:7,w:1,h:1,c:"#837D7D"},{x:12,y:7,w:1,h:1,c:"#2E5552"},{x:13,y:7,w:1,h:1,c:"#488894"},
  
  // Upper Body
  {x:10,y:8,w:1,h:1,c:"#9E7C59"},{x:13,y:8,w:1,h:1,c:"#9E7C59"},{x:12,y:8,w:1,h:1,c:"#488894"},
  {x:11,y:8,w:1,h:1,c:"#2E5552"},{x:9,y:8,w:1,h:1,c:"#A8A3AA"},{x:15,y:8,w:1,h:1,c:"#DBD2D3"},
  {x:8,y:8,w:1,h:1,c:"#DBD2D3"},{x:14,y:8,w:1,h:1,c:"#A8A3AA"},{x:7,y:8,w:1,h:1,c:"#837D7D"},
  {x:16,y:8,w:1,h:1,c:"#837D7D"},

  // Mid Body
  {x:13,y:9,w:1,h:1,c:"#9E7C59"},{x:10,y:9,w:1,h:1,c:"#2E5552"},{x:11,y:9,w:1,h:1,c:"#488894"},
  {x:12,y:9,w:1,h:1,c:"#B9A396"},{x:7,y:9,w:1,h:1,c:"#837D7D"},{x:16,y:9,w:1,h:1,c:"#837D7D"},
  {x:8,y:9,w:1,h:1,c:"#837D7D"},{x:14,y:9,w:1,h:1,c:"#837D7D"},{x:9,y:9,w:1,h:1,c:"#837D7D"},
  {x:15,y:9,w:1,h:1,c:"#837D7D"},{x:6,y:9,w:1,h:1,c:"#524326"},
  
  // Torso / Arms
  {x:13,y:10,w:1,h:1,c:"#9E7C59"},{x:14,y:10,w:1,h:1,c:"#9E7C59"},{x:9,y:10,w:1,h:1,c:"#2E5552"},
  {x:10,y:10,w:1,h:1,c:"#488894"},{x:11,y:10,w:1,h:1,c:"#AE8F73"},{x:12,y:10,w:1,h:1,c:"#B9A396"},
  {x:8,y:10,w:1,h:1,c:"#7C3F20"},{x:15,y:10,w:1,h:1,c:"#7C3F20"},{x:7,y:10,w:1,h:1,c:"#241706"},
  {x:6,y:10,w:1,h:1,c:"#524326"},

  // Lower Torso
  {x:13,y:11,w:1,h:1,c:"#9E7C59"},{x:9,y:11,w:1,h:1,c:"#488894"},{x:10,y:11,w:1,h:1,c:"#9E7C59"},
  {x:11,y:11,w:1,h:1,c:"#AE8F73"},{x:12,y:11,w:1,h:1,c:"#D5BAA9"},{x:14,y:11,w:1,h:1,c:"#7C3F20"},
  {x:16,y:11,w:1,h:1,c:"#7C3F20"},{x:7,y:11,w:1,h:1,c:"#7C3F20"},{x:8,y:11,w:1,h:1,c:"#241706"},
  {x:6,y:11,w:1,h:1,c:"#524326"},

  // Hips
  {x:13,y:12,w:1,h:1,c:"#9E7C59"},{x:10,y:12,w:1,h:1,c:"#9E7C59"},{x:11,y:12,w:1,h:1,c:"#AE8F73"},
  {x:12,y:12,w:1,h:1,c:"#AE8F73"},{x:14,y:12,w:1,h:1,c:"#7C3F20"},{x:9,y:12,w:1,h:1,c:"#7C3F20"},
  {x:16,y:12,w:1,h:1,c:"#7C3F20"},{x:7,y:12,w:1,h:1,c:"#7C3F20"},{x:8,y:12,w:1,h:1,c:"#241706"},
  {x:6,y:12,w:1,h:1,c:"#524326"},

  // Legs Start
  {x:11,y:13,w:1,h:1,c:"#9E7C59"},{x:12,y:13,w:1,h:1,c:"#D5BAA9"},{x:10,y:13,w:1,h:1,c:"#7C3F20"},
  {x:13,y:13,w:1,h:1,c:"#7C3F20"},{x:14,y:13,w:1,h:1,c:"#7C3F20"},{x:9,y:13,w:1,h:1,c:"#7C3F20"},
  {x:16,y:13,w:1,h:1,c:"#7C3F20"},{x:7,y:13,w:1,h:1,c:"#7C3F20"},{x:8,y:13,w:1,h:1,c:"#3C3124"},
  {x:6,y:13,w:1,h:1,c:"#524326"},

  // Legs / Gear
  {x:12,y:14,w:1,h:1,c:"#6C9BAA"},{x:6,y:14,w:1,h:1,c:"#524326"},{x:8,y:14,w:1,h:1,c:"#3C3124"},
  {x:9,y:14,w:1,h:1,c:"#3C3124"},{x:10,y:14,w:1,h:1,c:"#2E5552"},{x:13,y:14,w:1,h:1,c:"#2E5552"},
  {x:11,y:14,w:1,h:1,c:"#2E5552"},{x:7,y:14,w:1,h:1,c:"#A8A3AA"},{x:16,y:14,w:1,h:1,c:"#A8A3AA"},

  // Knees / Boots
  {x:12,y:15,w:1,h:1,c:"#488894"},{x:6,y:15,w:1,h:1,c:"#524326"},{x:8,y:15,w:1,h:1,c:"#3C3124"},
  {x:9,y:15,w:1,h:1,c:"#2E5552"},{x:10,y:15,w:1,h:1,c:"#2E5552"},{x:13,y:15,w:1,h:1,c:"#2E5552"},
  {x:14,y:15,w:1,h:1,c:"#2E5552"},{x:11,y:15,w:1,h:1,c:"#2E5552"},{x:7,y:15,w:1,h:1,c:"#837D7D"},
  {x:16,y:15,w:1,h:1,c:"#837D7D"},{x:17,y:15,w:1,h:1,c:"#837D7D"},

  // Lower Legs
  {x:9,y:16,w:1,h:1,c:"#488894"},{x:14,y:16,w:1,h:1,c:"#488894"},{x:10,y:16,w:1,h:1,c:"#2E5552"},
  {x:13,y:16,w:1,h:1,c:"#2E5552"},{x:11,y:16,w:1,h:1,c:"#2E5552"},{x:12,y:16,w:1,h:1,c:"#2E5552"},
  {x:6,y:16,w:1,h:1,c:"#524326"},{x:8,y:16,w:1,h:1,c:"#3C3124"},{x:7,y:16,w:1,h:1,c:"#FFC17A"},
  {x:16,y:16,w:1,h:1,c:"#FFC17A"},

  // Shin
  {x:9,y:17,w:1,h:1,c:"#488894"},{x:14,y:17,w:1,h:1,c:"#488894"},{x:10,y:17,w:1,h:1,c:"#2E5552"},
  {x:13,y:17,w:1,h:1,c:"#2E5552"},{x:6,y:17,w:1,h:1,c:"#524326"},{x:7,y:17,w:1,h:1,c:"#3C3124"},
  {x:8,y:17,w:1,h:1,c:"#3C3124"},

  // Shin 2
  {x:9,y:18,w:1,h:1,c:"#488894"},{x:14,y:18,w:1,h:1,c:"#488894"},{x:8,y:18,w:1,h:1,c:"#2E5552"},
  {x:10,y:18,w:1,h:1,c:"#2E5552"},{x:6,y:18,w:1,h:1,c:"#524326"},{x:7,y:18,w:1,h:1,c:"#3C3124"},

  // Shin 3
  {x:9,y:19,w:1,h:1,c:"#488894"},{x:14,y:19,w:1,h:1,c:"#488894"},{x:8,y:19,w:1,h:1,c:"#2E5552"},
  {x:6,y:19,w:1,h:1,c:"#6E6252"},{x:7,y:19,w:1,h:1,c:"#3C3124"},

  // Ankle
  {x:9,y:20,w:1,h:1,c:"#488894"},{x:14,y:20,w:1,h:1,c:"#488894"},{x:6,y:20,w:1,h:1,c:"#6E6252"},
  {x:7,y:20,w:1,h:1,c:"#3C3124"},

  // Foot Top
  {x:9,y:21,w:1,h:1,c:"#2E5552"},{x:14,y:21,w:1,h:1,c:"#2E5552"},{x:6,y:21,w:1,h:1,c:"#6E6252"},
  {x:7,y:21,w:1,h:1,c:"#6E6252"},

  // Foot
  {x:9,y:22,w:1,h:1,c:"#241706"},{x:14,y:22,w:1,h:1,c:"#241706"},{x:6,y:22,w:1,h:1,c:"#6E6252"},

  // Ground / Shadow / Sole
  {x:9,y:23,w:1,h:1,c:"#241706"},{x:8,y:23,w:1,h:1,c:"#BAB9A7"},{x:10,y:23,w:1,h:1,c:"#BAB9A7"},
  {x:11,y:23,w:1,h:1,c:"#BAB9A7"},{x:12,y:23,w:1,h:1,c:"#BAB9A7"},{x:13,y:23,w:1,h:1,c:"#BAB9A7"},
  {x:15,y:23,w:1,h:1,c:"#BAB9A7"},{x:16,y:23,w:1,h:1,c:"#BAB9A7"},{x:17,y:23,w:1,h:1,c:"#BAB9A7"},
  {x:14,y:23,w:1,h:1,c:"#241706"}
];

/**
 * Generates an SVG string from pixel data
 */
function renderSvg(pixels, width=24, height=24) {
  const rects = pixels.map(p => 
    `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${p.c}"/>`
  ).join('');
  
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}

/**
 * Converts an SVG string to a Data URI for use in CSS
 */
function svgToDataUri(svgString) {
  return `data:image/svg+xml;base64,${btoa(svgString)}`;
}

// Generate the frames
// Idle: The base SVG
const idleFrame = renderSvg(CPT_PIXELS);

// Bob: Shift the upper body (pixels < y21) down by 1 pixel to simulate breathing/walking bounce
// We don't shift the feet (y >= 21) so they stay planted
const bobPixels = CPT_PIXELS.map(p => {
  if (p.y < 21) {
    return { ...p, y: p.y + 1 };
  }
  return p;
});
const bobFrame = renderSvg(bobPixels);

export const SPRITES = {
  cpt: {
    idle: svgToDataUri(idleFrame),
    bob: svgToDataUri(bobFrame)
  }
};

