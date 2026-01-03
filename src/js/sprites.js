/**
 * VETUU — Sprite Manager
 * Handles SVG sprite generation and management.
 * 
 * Character sprites are 24x32 (tile width × 1.33 height)
 * This creates natural human proportions while maintaining tile-based movement.
 */

// Sprite dimensions
export const SPRITE_WIDTH = 24;
export const SPRITE_HEIGHT = 32;

// Raw SVG for 24x32 skeleton character
const SKELETON_SVG = `<svg width="24" height="32" viewBox="0 0 24 32" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="10" y="28" width="1" height="1" fill="#BAB9A7"/>
<rect x="12" y="28" width="1" height="1" fill="#BAB9A7"/>
<rect x="14" y="28" width="1" height="1" fill="#BAB9A7"/>
<rect x="18" y="28" width="1" height="1" fill="#BAB9A7"/>
<rect x="6" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="8" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="16" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="10" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="12" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="14" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="18" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="7" y="28" width="1" height="1" fill="#BAB9A7"/>
<rect x="11" y="28" width="1" height="1" fill="#BAB9A7"/>
<rect x="13" y="28" width="1" height="1" fill="#BAB9A7"/>
<rect x="15" y="28" width="1" height="1" fill="#BAB9A7"/>
<rect x="7" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="9" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="17" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="11" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="13" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="15" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="19" y="30" width="1" height="1" fill="#BAB9A7"/>
<rect x="6" y="29" width="1" height="1" fill="#BAB9A7"/>
<rect x="10" y="29" width="1" height="1" fill="#BAB9A7"/>
<rect x="12" y="29" width="1" height="1" fill="#BAB9A7"/>
<rect x="14" y="29" width="1" height="1" fill="#BAB9A7"/>
<rect x="18" y="29" width="1" height="1" fill="#BAB9A7"/>
<rect x="8" y="31" width="1" height="1" fill="#BAB9A7"/>
<rect x="16" y="31" width="1" height="1" fill="#BAB9A7"/>
<rect x="10" y="31" width="1" height="1" fill="#BAB9A7"/>
<rect x="18" y="31" width="1" height="1" fill="#BAB9A7"/>
<rect x="7" y="29" width="1" height="1" fill="#BAB9A7"/>
<rect x="11" y="29" width="1" height="1" fill="#BAB9A7"/>
<rect x="13" y="29" width="1" height="1" fill="#BAB9A7"/>
<rect x="15" y="29" width="1" height="1" fill="#BAB9A7"/>
<rect x="19" y="29" width="1" height="1" fill="#BAB9A7"/>
<rect x="7" y="31" width="1" height="1" fill="#BAB9A7"/>
<rect x="9" y="31" width="1" height="1" fill="#BAB9A7"/>
<rect x="17" y="31" width="1" height="1" fill="#BAB9A7"/>
<rect x="15" y="31" width="1" height="1" fill="#BAB9A7"/>
<rect x="15" y="22" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="22" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="22" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="23" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="23" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="23" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="24" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="24" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="24" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="25" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="25" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="26" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="26" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="27" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="27" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="28" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="28" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="29" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="29" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="22" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="22" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="22" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="23" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="23" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="23" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="24" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="24" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="24" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="25" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="25" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="26" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="26" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="27" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="27" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="28" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="28" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="29" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="29" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="20" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="20" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="20" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="20" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="20" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="20" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="20" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="20" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="21" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="21" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="21" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="21" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="21" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="21" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="21" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="21" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="20" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="20" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="20" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="21" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="21" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="21" width="1" height="1" fill="#FFC17A"/>
<rect x="18" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="19" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="18" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="19" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="18" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="19" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="19" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="20" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="19" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="20" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="19" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="20" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="19" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="20" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="19" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="20" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="19" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="20" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="7" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="6" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="7" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="6" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="7" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="6" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="6" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="5" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="6" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="6" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="5" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="5" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="4" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="3" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="4" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="3" y="18" width="1" height="1" fill="#FFC17A"/>
<rect x="4" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="3" y="19" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="17" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="13" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="14" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="15" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="16" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="3" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="2" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="4" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="8" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="4" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="8" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="4" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="8" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="5" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="9" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="6" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="7" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="5" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="9" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="6" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="7" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="5" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="9" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="6" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="7" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="3" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="2" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="4" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="8" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="5" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="9" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="6" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="7" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="3" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="2" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="4" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="8" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="5" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="9" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="3" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="2" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="4" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="8" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="5" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="9" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="6" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="7" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="3" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="2" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="4" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="8" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="5" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="9" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="3" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="2" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="4" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="8" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="5" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="9" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="3" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="2" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="4" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="8" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="5" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="9" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="6" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="7" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="3" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="2" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="4" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="8" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="5" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="9" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="11" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="12" width="1" height="1" fill="#FFC17A"/>
<rect x="10" y="10" width="1" height="1" fill="#FFC17A"/>
<rect x="9" y="10" width="1" height="1" fill="#FFC17A"/>
<rect x="8" y="10" width="1" height="1" fill="#FFC17A"/>
<rect x="14" y="10" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="10" width="1" height="1" fill="#FFC17A"/>
<rect x="15" y="10" width="1" height="1" fill="#FFC17A"/>
<rect x="12" y="10" width="1" height="1" fill="#FFC17A"/>
<rect x="16" y="10" width="1" height="1" fill="#FFC17A"/>
<rect x="13" y="10" width="1" height="1" fill="#FFC17A"/>
<rect x="17" y="10" width="1" height="1" fill="#FFC17A"/>
<rect x="11" y="6" width="1" height="1" fill="#241706"/>
<rect x="11" y="7" width="1" height="1" fill="#241706"/>
<rect x="12" y="6" width="1" height="1" fill="#241706"/>
<rect x="12" y="7" width="1" height="1" fill="#241706"/>
<rect x="16" y="6" width="1" height="1" fill="#241706"/>
<rect x="16" y="7" width="1" height="1" fill="#241706"/>
<rect x="17" y="6" width="1" height="1" fill="#241706"/>
<rect x="17" y="7" width="1" height="1" fill="#241706"/>
</svg>`;

/**
 * Converts an SVG string to a Data URI for use in CSS
 */
function svgToDataUri(svgString) {
  return `data:image/svg+xml;base64,${btoa(svgString)}`;
}

/**
 * Remove shadow/dust pixels (#BAB9A7) so outline wraps only the body
 */
function removeShadowPixels(svgString) {
  return svgString
    .split('\n')
    .filter(line => !line.includes('fill="#BAB9A7"'))
    .join('\n');
}

const cleanedSvg = removeShadowPixels(SKELETON_SVG);
const spriteDataUri = svgToDataUri(cleanedSvg);

// Export universal sprite for all actors
export const SPRITES = {
  actor: {
    idle: spriteDataUri
  }
};
