import globals from 'globals';

export default [
  {
    // Apply to all JS files in src/js
    files: ['src/js/**/*.js'],
    
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
      }
    },
    
    rules: {
      // Catch undefined variables and functions - the main reason we added ESLint
      'no-undef': 'error',
      
      // Catch unused variables (helps find dead code)
      'no-unused-vars': ['warn', { 
        argsIgnorePattern: '^_',      // Allow _unused params
        varsIgnorePattern: '^_',       // Allow _unused vars
        caughtErrors: 'none'           // Don't warn on catch(e) unused
      }],
      
      // Prevent common mistakes
      'no-dupe-keys': 'error',           // Duplicate keys in objects
      'no-dupe-args': 'error',           // Duplicate function params
      'no-duplicate-case': 'error',      // Duplicate case labels
      'no-unreachable': 'error',         // Code after return/throw
      'no-constant-condition': 'warn',   // if(true), while(false)
      'no-empty': 'warn',                // Empty blocks
      'no-extra-semi': 'warn',           // Unnecessary semicolons
      'no-func-assign': 'error',         // Reassigning functions
      'no-inner-declarations': 'error',  // Functions in nested blocks
      'no-invalid-regexp': 'error',      // Invalid regex
      'no-irregular-whitespace': 'error',// Weird whitespace chars
      'no-sparse-arrays': 'warn',        // [1,,3] sparse arrays
      'use-isnan': 'error',              // Use isNaN() not x === NaN
      'valid-typeof': 'error',           // typeof x === 'strng' typos
      
      // Code quality
      'eqeqeq': ['warn', 'smart'],        // Prefer === over ==
      'no-eval': 'error',                 // No eval()
      'no-implied-eval': 'error',         // No setTimeout('code')
      'no-self-assign': 'error',          // x = x
      'no-self-compare': 'error',         // x === x
      'no-useless-return': 'warn',        // return; at end of function
      
      // Style (warnings only, not blocking)
      'no-trailing-spaces': 'off',        // Don't care about trailing spaces
      'semi': 'off',                       // Don't enforce semicolon style
      'quotes': 'off',                     // Don't enforce quote style
    }
  }
];



