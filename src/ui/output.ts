import chalk from 'chalk';
import ora from 'ora';
import { table } from 'table';
import boxen from 'boxen';
// @ts-ignore - gradient-string doesn't have types
import gradient from 'gradient-string';
import figlet from 'figlet';
import { OutputHandler, Spinner, ProgressBar, BoxOptions } from '../types/index.js';

export class CLIOutputHandler implements OutputHandler {
  private spinners: Map<string, Spinner> = new Map();
  private progressBars: Map<string, ProgressBar> = new Map();

  info(message: string): void {
    console.log(chalk.blue('ℹ'), message);
  }

  success(message: string): void {
    console.log(chalk.green('✓'), message);
  }

  warning(message: string): void {
    console.log(chalk.yellow('⚠'), message);
  }

  error(message: string): void {
    console.log(chalk.red('✗'), message);
  }

  table(data: unknown[]): void {
    if (data.length === 0) {
      this.info('No data to display');
      return;
    }

    const headers = Object.keys(data[0] as object);
    const tableData = [
      headers.map(h => chalk.bold(h)),
      ...data.map(row => headers.map(h => String((row as any)[h] || '')))
    ];

    const tableConfig = {
      border: {
        topBody: '─',
        topJoin: '┬',
        topLeft: '┌',
        topRight: '┐',
        bottomBody: '─',
        bottomJoin: '┴',
        bottomLeft: '└',
        bottomRight: '┘',
        bodyLeft: '│',
        bodyRight: '│',
        bodyJoin: '│',
        joinBody: '─',
        joinLeft: '├',
        joinRight: '┤',
        joinJoin: '┼'
      },
      columnDefault: {
        paddingLeft: 1,
        paddingRight: 1
      }
    };

    console.log(table(tableData, tableConfig));
  }

  progress(message: string): ProgressBar {
    const id = Math.random().toString(36).substr(2, 9);
    const progressBar = {
      id,
      message,
      update: (progress: number, text?: string) => {
        const bar = '█'.repeat(Math.floor(progress / 2)) + '░'.repeat(50 - Math.floor(progress / 2));
        const displayText = text || message;
        process.stdout.write(`\r${chalk.blue(displayText)} [${bar}] ${progress}%`);
        if (progress >= 100) {
          process.stdout.write('\n');
        }
      },
      stop: () => {
        process.stdout.write('\n');
        this.progressBars.delete(id);
      }
    };
    
    this.progressBars.set(id, progressBar);
    return progressBar;
  }

  spinner(message: string): Spinner {
    const id = Math.random().toString(36).substr(2, 9);
    const spinner = ora({
      text: message,
      spinner: 'dots'
    }).start();
    
    this.spinners.set(id, spinner as any);
    return {
      start: () => {},
      update: (text: string) => { spinner.text = text; },
      succeed: (text?: string) => {
        spinner.succeed(text);
        this.spinners.delete(id);
      },
      fail: (text?: string) => {
        spinner.fail(text);
        this.spinners.delete(id);
      },
      stop: () => {
        spinner.stop();
        this.spinners.delete(id);
      }
    };
  }

  banner(text: string): void {
    const gradientText = gradient.rainbow.multiline(figlet.textSync(text, { font: 'ANSI Shadow' }));
    console.log(gradientText);
  }

  box(message: string, options?: BoxOptions): void {
    const defaultOptions = {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'blue',
      backgroundColor: 'black'
    };
    
    console.log(boxen(message, { ...defaultOptions, ...options } as any));
  }

  section(title: string): void {
    console.log('\n' + chalk.bold.underline(title) + '\n');
  }

  list(items: string[], options?: { bullet?: string; color?: string }): void {
    const bullet = options?.bullet || '•';
    const color = options?.color || 'white';
    
    items.forEach(item => {
      console.log((chalk as unknown as Record<string, any>)[color](`${bullet} ${item}`));
    });
  }

  code(code: string, language?: string): void {
    const codeBlock = '```' + (language || '') + '\n' + code + '\n```';
    console.log(chalk.gray(codeBlock));
  }

  json(obj: unknown): void {
    console.log(JSON.stringify(obj, null, 2));
  }

  clear(): void {
    console.clear();
  }

  // Clean up all active spinners and progress bars
  cleanup(): void {
    this.spinners.forEach(spinner => spinner.stop());
    this.progressBars.forEach(progress => progress.stop());
    this.spinners.clear();
    this.progressBars.clear();
  }
}