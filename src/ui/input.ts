import inquirer from 'inquirer';
import { InputHandler, PromptOptions } from '../types/index.js';

export class CLIInputHandler implements InputHandler {
  async prompt(question: string, options?: PromptOptions): Promise<string> {
    const { answer } = await inquirer.prompt<{ answer: string }>([
      {
        type: 'input',
        name: 'answer',
        message: question,
        ...options
      }
    ] as any);
    return answer;
  }

  async confirm(message: string): Promise<boolean> {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: 'confirm',
        name: 'confirmed',
        message: message,
        default: false
      }
    ] as any);
    return confirmed;
  }

  async select(message: string, choices: string[]): Promise<string> {
    const { selected } = await inquirer.prompt<{ selected: string }>([
      {
        type: 'list',
        name: 'selected',
        message: message,
        choices: choices
      }
    ] as any);
    return selected;
  }

  async multiSelect(message: string, choices: string[]): Promise<string[]> {
    const { selected } = await inquirer.prompt<{ selected: string[] }>([
      {
        type: 'checkbox',
        name: 'selected',
        message: message,
        choices: choices
      }
    ] as any);
    return selected;
  }

  async password(message: string): Promise<string> {
    const { password } = await inquirer.prompt<{ password: string }>([
      {
        type: 'password',
        name: 'password',
        message: message,
        mask: '*'
      }
    ] as any);
    return password;
  }

  async number(message: string, options?: { min?: number; max?: number; default?: number }): Promise<number> {
    const { number } = await inquirer.prompt<{ number: number }>([
      {
        type: 'number',
        name: 'number',
        message: message,
        ...options
      }
    ] as any);
    return number;
  }

  async editor(message: string, options?: { default?: string }): Promise<string> {
    const { content } = await inquirer.prompt<{ content: string }>([
      {
        type: 'editor',
        name: 'content',
        message: message,
        ...options
      }
    ] as any);
    return content;
  }

  async autocomplete(message: string, source: (answersSoFar: Record<string, unknown>, input: string) => Promise<string[]>): Promise<string> {
    const { selected } = await inquirer.prompt<{ selected: string }>([
      {
        type: 'autocomplete',
        name: 'selected',
        message: message,
        source: source
      }
    ] as any);
    return selected;
  }

  async datetime(message: string, options?: { default?: Date }): Promise<Date> {
    const { datetime } = await inquirer.prompt<{ datetime: Date }>([
      {
        type: 'datetime',
        name: 'datetime',
        message: message,
        ...options
      }
    ] as any);
    return datetime;
  }

  async file(message: string, options?: { basePath?: string; extensions?: string[] }): Promise<string> {
    const { filePath } = await inquirer.prompt<{ filePath: string }>([
      {
        type: 'file-tree-selection',
        name: 'filePath',
        message: message,
        ...options
      }
    ] as any);
    return filePath;
  }

  async directory(message: string, options?: { basePath?: string }): Promise<string> {
    const { directory } = await inquirer.prompt<{ directory: string }>([
      {
        type: 'file-tree-selection',
        name: 'directory',
        message: message,
        onlyShowDir: true,
        ...options
      }
    ] as any);
    return directory;
  }
}