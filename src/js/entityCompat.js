/**
 * VETUU — Entity Compatibility Layer
 * 
 * Standardizes HP keys across the codebase to prevent "bad bar math" bugs.
 * Canonical key: maxHP
 * Legacy alias: maxHp (kept for backward compatibility)
 * 
 * Use these helpers whenever reading/writing max health to ensure consistency.
 */

/**
 * Normalize health keys on an entity to ensure both maxHP and maxHp exist and match.
 * Call this after creating or loading any entity (player, enemy, NPC).
 * 
 * @param {object} entity - Any entity with health
 * @returns {object} The same entity, mutated with normalized keys
 */
export function normalizeHealthKeys(entity) {
  if (!entity) return entity;
  
  // Case 1: Neither key exists - infer from current hp
  if (entity.maxHP == null && entity.maxHp == null) {
    const inferred = entity.hp ?? 0;
    entity.maxHP = inferred;
    entity.maxHp = inferred;
    return entity;
  }
  
  // Case 2: Only maxHp exists - copy to maxHP
  if (entity.maxHP == null && entity.maxHp != null) {
    entity.maxHP = entity.maxHp;
    return entity;
  }
  
  // Case 3: Only maxHP exists - copy to maxHp
  if (entity.maxHp == null && entity.maxHP != null) {
    entity.maxHp = entity.maxHP;
    return entity;
  }
  
  // Case 4: Both exist but don't match - use the larger value
  if (entity.maxHP != null && entity.maxHp != null && entity.maxHP !== entity.maxHp) {
    const m = Math.max(entity.maxHP, entity.maxHp);
    entity.maxHP = m;
    entity.maxHp = m;
  }
  
  return entity;
}

/**
 * Get the max HP of an entity, normalizing keys if needed.
 * Always use this instead of directly accessing maxHP or maxHp.
 * 
 * @param {object} entity - Any entity with health
 * @returns {number} The max HP value (0 if entity is null/undefined)
 */
export function getMaxHP(entity) {
  if (!entity) return 0;
  return normalizeHealthKeys(entity).maxHP ?? 0;
}

/**
 * Set the max HP of an entity, keeping both keys in sync.
 * 
 * @param {object} entity - Any entity with health
 * @param {number} value - The new max HP value
 */
export function setMaxHP(entity, value) {
  if (!entity) return;
  entity.maxHP = value;
  entity.maxHp = value;
}

/**
 * Clamp current HP to valid range [0, maxHP].
 * Also ensures hp exists (defaults to maxHP if missing).
 * 
 * @param {object} entity - Any entity with health
 * @returns {object} The same entity, mutated with clamped hp
 */
export function clampHP(entity) {
  if (!entity) return entity;
  
  const max = getMaxHP(entity);
  if (entity.hp == null) entity.hp = max;
  entity.hp = Math.max(0, Math.min(entity.hp, max));
  return entity;
}

/**
 * Calculate HP percentage safely (handles zero max HP).
 * 
 * @param {object} entity - Any entity with health
 * @returns {number} Percentage 0-100
 */
export function getHPPercent(entity) {
  if (!entity) return 0;
  const max = getMaxHP(entity);
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (entity.hp / max) * 100));
}



