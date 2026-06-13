import readline from 'readline';
import chalk from 'chalk';

type TuiCallbacks = {
  onSubmit: (text: string) => Promise<void>;
  onExit: () => void;
};

export class ChatTUI {
  private rl: readline.Interface;
  private history: Array<{ role: 'user' | 'assistant' | 'tool'; text: string }>; 
  private inputPrompt = chalk.cyan('You') + ': ';
  private streamingActive = false;
  private spinnerTimer: NodeJS.Timeout | null = null; // disabled animation (kept for future)
  private spinnerFrames = [''];
  private spinnerIndex = 0;
  private spinnerLabel = '';
  private statusEnabled = true;
  private lastPhase: 'Thinking' | 'Tool' | 'Waiting' | 'Generating' | 'Done' | '' = '';
  private lastToolName: string | undefined;
  private isClosed = false;

  constructor(private callbacks: TuiCallbacks) {
    this.history = [];
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.bind();
  }

  private bind() {
    process.stdout.write('\x1b[2J\x1b[0f'); // clear once on start
    this.render();
    this.ask();
    this.rl.on('SIGINT', () => {
      this.callbacks.onExit();
      this.rl.close();
    });
    this.rl.on('close', () => {
      this.isClosed = true;
    });
  }

  private ask() {
    if (this.isClosed) return;
    this.rl.question(this.inputPrompt, async (text) => {
      if (text.trim().toLowerCase() === '/exit') {
        this.callbacks.onExit();
        this.rl.close();
        return;
      }
      if (text.trim()) {
        this.history.push({ role: 'user', text });
        this.render();
        this.streamingActive = true;
        await this.callbacks.onSubmit(text);
        this.streamingActive = false;
        process.stdout.write('\n');
      }
      if (!this.isClosed) this.ask();
    });
  }

  public appendAssistantChunk(chunk: string) {
    if (!chunk) return;
    this.stopSpinner();
    const last = this.history[this.history.length - 1];
    if (!(last && last.role === 'assistant')) {
      this.history.push({ role: 'assistant', text: '' });
      console.log(chalk.green('AI:  '));
    }
    const current = this.history[this.history.length - 1];
    current.text += chunk;
    // Stream chunk without full re-render to avoid echoing the entire frame
    process.stdout.write(chunk);
  }

  public appendToolEvent(text: string) {
    this.stopSpinner();
    this.history.push({ role: 'tool', text });
    // Print tool events compactly during streaming
    const prefix = chalk.yellow('Tool:');
    process.stdout.write(`\n${prefix} ${text}\n`);
  }

  private render() {
    process.stdout.write('\x1b[2J\x1b[0f');
    console.log(chalk.bold('Kablewy Chat (TUI) - /exit to quit'));
    console.log('');
    for (const msg of this.history) {
      if (msg.role === 'user') console.log(chalk.cyan('You: ') + msg.text + '\n');
      if (msg.role === 'assistant') console.log(chalk.green('AI:  ') + msg.text + '\n');
      if (msg.role === 'tool') console.log(chalk.yellow('Tool:') + ' ' + msg.text + '\n');
    }
  }

  private startSpinner(label: string) {
    if (!this.statusEnabled) return;
    this.spinnerLabel = ` ${label} `;
    // Print simple status line on stderr (no CR animation to avoid mixing with stdout)
    process.stderr.write(`${chalk.gray('[Status]')}${chalk.gray(this.spinnerLabel)}\n`);
  }

  private stopSpinner(doneLabel?: string) {
    if (doneLabel && this.statusEnabled) {
      process.stderr.write(`${chalk.green('✓')} ${chalk.gray(doneLabel)}\n`);
    }
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.spinnerIndex = 0;
  }

  public setStatusPhase(phase: 'Thinking' | 'Tool' | 'Waiting' | 'Generating' | 'Done', toolName?: string) {
    if (!this.statusEnabled) return;
    // Avoid duplicate status prints for same phase/tool
    if (this.lastPhase === phase && (phase !== 'Tool' || this.lastToolName === toolName)) {
      return;
    }
    const map: Record<string, string> = {
      'Thinking': 'Thinking',
      'Tool': toolName ? `Tool: ${toolName}` : 'Tool',
      'Waiting': 'Waiting for tool',
      'Generating': 'Generating',
      'Done': 'Done'
    } as any;
    // Reset spinner and start with new label
    this.stopSpinner();
    if (phase === 'Done') {
      this.stopSpinner('Done');
      this.lastPhase = phase;
      this.lastToolName = toolName;
      return;
    }
    this.startSpinner(map[phase] || '');
    this.lastPhase = phase;
    this.lastToolName = toolName;
  }
}


