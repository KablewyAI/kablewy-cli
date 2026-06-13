import { describe, it, expect, beforeEach } from 'vitest';
import { CLIInputHandler } from '../../src/ui/input.js';

describe('CLIInputHandler', () => {
  let input: CLIInputHandler;

  beforeEach(() => {
    input = new CLIInputHandler();
  });

  describe('basic functionality', () => {
    it('should create input handler', () => {
      expect(input).toBeDefined();
      expect(input).toHaveProperty('prompt');
      expect(input).toHaveProperty('confirm');
      expect(input).toHaveProperty('select');
      expect(input).toHaveProperty('multiSelect');
      expect(input).toHaveProperty('password');
      expect(input).toHaveProperty('number');
      expect(input).toHaveProperty('editor');
      expect(input).toHaveProperty('autocomplete');
      expect(input).toHaveProperty('datetime');
      expect(input).toHaveProperty('file');
      expect(input).toHaveProperty('directory');
    });

    it('should have all required methods', () => {
      expect(typeof input.prompt).toBe('function');
      expect(typeof input.confirm).toBe('function');
      expect(typeof input.select).toBe('function');
      expect(typeof input.multiSelect).toBe('function');
      expect(typeof input.password).toBe('function');
      expect(typeof input.number).toBe('function');
      expect(typeof input.editor).toBe('function');
      expect(typeof input.autocomplete).toBe('function');
      expect(typeof input.datetime).toBe('function');
      expect(typeof input.file).toBe('function');
      expect(typeof input.directory).toBe('function');
    });
  });
});