import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CLIOutputHandler } from '../../src/ui/output.js';

describe('CLIOutputHandler', () => {
  let output: CLIOutputHandler;
  let consoleSpy: unknown;

  beforeEach(() => {
    output = new CLIOutputHandler();
    
    // Spy on console methods
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      clear: vi.spyOn(console, 'clear').mockImplementation(() => {}),
      stdout: {
        write: vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      }
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    output.cleanup();
  });

  describe('basic output methods', () => {
    it('should output info messages', () => {
      output.info('Test info message');
      
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('ℹ'),
        'Test info message'
      );
    });

    it('should output success messages', () => {
      output.success('Test success message');
      
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('✓'),
        'Test success message'
      );
    });

    it('should output warning messages', () => {
      output.warning('Test warning message');
      
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('⚠'),
        'Test warning message'
      );
    });

    it('should output error messages', () => {
      output.error('Test error message');
      
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('✗'),
        'Test error message'
      );
    });
  });

  describe('table output', () => {
    it('should display tables with data', () => {
      const data = [
        { name: 'John', age: 30 },
        { name: 'Jane', age: 25 }
      ];
      
      output.table(data);
      
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('name')
      );
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('age')
      );
    });

    it('should handle empty table data', () => {
      output.table([]);

      // Empty table delegates to info(), which logs the ℹ prefix as a
      // separate argument alongside the message.
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('ℹ'),
        'No data to display'
      );
    });
  });

  describe('progress indicators', () => {
    it('should create progress bars', () => {
      const progress = output.progress('Test progress');
      
      expect(progress).toBeDefined();
      expect(progress).toHaveProperty('update');
      expect(progress).toHaveProperty('stop');
    });

    it('should update progress bars', () => {
      const progress = output.progress('Test progress');
      
      progress.update(50, 'Halfway done');
      
      expect(consoleSpy.stdout.write).toHaveBeenCalledWith(
        expect.stringContaining('50%')
      );
    });

    it('should stop progress bars', () => {
      const progress = output.progress('Test progress');
      
      progress.stop();
      
      expect(consoleSpy.stdout.write).toHaveBeenCalledWith('\n');
    });
  });

  describe('spinners', () => {
    it('should create spinners', () => {
      const spinner = output.spinner('Test spinner');
      
      expect(spinner).toBeDefined();
      expect(spinner).toHaveProperty('update');
      expect(spinner).toHaveProperty('succeed');
      expect(spinner).toHaveProperty('fail');
      expect(spinner).toHaveProperty('stop');
    });

    it('should update spinner text', () => {
      const spinner = output.spinner('Test spinner');
      
      spinner.update('Updated text');
      
      // The spinner updates are handled internally by ora
      // We just verify the method exists and can be called
      expect(spinner.update).toBeDefined();
    });

    it('should succeed spinners', () => {
      const spinner = output.spinner('Test spinner');
      
      spinner.succeed('Success message');
      
      // Verify the method exists and can be called
      expect(spinner.succeed).toBeDefined();
    });

    it('should fail spinners', () => {
      const spinner = output.spinner('Test spinner');
      
      spinner.fail('Error message');
      
      // Verify the method exists and can be called
      expect(spinner.fail).toBeDefined();
    });

    it('should stop spinners', () => {
      const spinner = output.spinner('Test spinner');
      
      spinner.stop();
      
      // Verify the method exists and can be called
      expect(spinner.stop).toBeDefined();
    });
  });

  describe('special formatting', () => {
    it('should display banners', () => {
      output.banner('TEST');

      // The banner renders text as figlet ASCII-art (ANSI Shadow font), so
      // the literal "TEST" no longer appears — assert the rendered block art
      // is logged instead.
      expect(consoleSpy.log).toHaveBeenCalledTimes(1);
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('█')
      );
    });

    it('should display boxes', () => {
      output.box('Test message');
      
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('Test message')
      );
    });

    it('should display sections', () => {
      output.section('Test Section');
      
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('Test Section')
      );
    });

    it('should display lists', () => {
      const items = ['Item 1', 'Item 2', 'Item 3'];
      
      output.list(items);
      
      expect(consoleSpy.log).toHaveBeenCalledTimes(3);
    });

    it('should display code blocks', () => {
      const code = 'console.log("Hello, World!");';
      
      output.code(code, 'javascript');
      
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('```javascript')
      );
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining(code)
      );
    });

    it('should display JSON', () => {
      const obj = { name: 'test', value: 123 };
      
      output.json(obj);
      
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('"name": "test"')
      );
    });
  });

  describe('cleanup', () => {
    it('should cleanup all active indicators', () => {
      output.progress('Test progress');
      output.spinner('Test spinner');
      
      output.cleanup();
      
      // Verify cleanup doesn't throw errors
      expect(() => output.cleanup()).not.toThrow();
    });
  });

  describe('clear functionality', () => {
    it('should clear the console', () => {
      output.clear();
      
      expect(consoleSpy.clear).toHaveBeenCalled();
    });
  });
});