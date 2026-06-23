import React, { useState, useEffect, useMemo } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { spawn } from 'child_process';
import { appendFile, mkdir, readFile, stat as fsStat, readdir as fsReaddir } from 'fs/promises';
import path from 'path';
import {
  AgentSafetyConfig,
  classifyShellCommand,
  isPathInside,
  redactAuditPayload,
  redactText,
  ShellCommandClassification,
  takeOutputChunk
} from '../utils/agent-safety.js';

type Message = { role: 'user' | 'assistant' | 'tool'; text: string };
type PendingShellCommand = { command: string; classification: ShellCommandClassification };

export type InkChatProps = {
  title?: string;
  model?: string;
  mode?: 'chat' | 'agent';
  requireShellApproval?: boolean;
  safety?: AgentSafetyConfig;
  onExit?: () => void;
  startStreaming: (
    text: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    handlers: { onText: (chunk: string) => void; onTool: (evt: string) => void; onDone: () => void },
    request?: { model: string }
  ) => Promise<void>;
};

export function runInkChat(ui: React.ReactElement) {
  return render(ui);
}

export const InkChat: React.FC<InkChatProps> = ({
  title = 'Kablewy Chat',
  model = 'gpt-5.4',
  mode = 'chat',
  requireShellApproval = false,
  safety,
  onExit,
  startStreaming
}) => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<'Thinking' | 'Tool' | 'Waiting' | 'Generating' | 'Idle'>('Idle');
  const [tokenInfo, setTokenInfo] = useState<string>('0.0%');
  const [tokenCount, setTokenCount] = useState<number>(0);
  const [filesEdited, setFilesEdited] = useState<number>(0);
  const [lastFilesAttached, setLastFilesAttached] = useState<number>(0);
  const [activeModel, setActiveModel] = useState<string>(model);
  const [pendingShellCommand, setPendingShellCommand] = useState<PendingShellCommand | null>(null);
  const [pendingAttachmentSnippets, setPendingAttachmentSnippets] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [pickerItems, setPickerItems] = useState<string[]>([]);
  const [pickerIndex, setPickerIndex] = useState<number>(0);
  const [blockNextSubmit, setBlockNextSubmit] = useState<boolean>(false);
  const [autoRun, setAutoRun] = useState<boolean>(false);
  const [planMode, setPlanMode] = useState<boolean>(false);

  const MODEL_INPUT_WINDOW: Record<string, number> = {
    'gpt-5': 128000,
    'gpt-4o': 128000,
  };
  const rootCwd = safety?.cwd || process.cwd();
  const allowDangerousShell = safety?.allowDangerousShell ?? false;
  const allowOutsideCwd = safety?.allowOutsideCwd ?? false;
  const commandTimeoutMs = safety?.commandTimeoutMs ?? 120000;
  const maxOutputBytes = safety?.maxOutputBytes ?? 262144;
  const auditLogPath = safety?.auditLogPath;
  const charToToken = (chars: number) => Math.ceil(chars / 4);
  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(2)}m`;
    if (n >= 1000) return `${(n / 1000).toFixed(2)}k`;
    return String(n);
  };

  const updateTokenInfo = () => {
    const pendingChars = pendingAttachmentSnippets.reduce((n, s) => n + s.length, 0);
    const totalChars = messages.reduce((n, m) => n + (m.text?.length || 0), 0) + input.length + pendingChars;
    const estimate = charToToken(totalChars);
    const windowSize = MODEL_INPUT_WINDOW[activeModel] || 128000;
    const pct = Math.min(100, (estimate / windowSize) * 100);
    setTokenInfo(`${pct.toFixed(1)}%`);
    setTokenCount(estimate);
  };

  useEffect(() => {
    updateTokenInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, input, pendingAttachmentSnippets, activeModel]);

  const writeAudit = async (type: string, payload: Record<string, unknown> = {}) => {
    if (!auditLogPath) return;
    try {
      await mkdir(path.dirname(auditLogPath), { recursive: true });
      const event = redactAuditPayload({
        ts: new Date().toISOString(),
        type,
        mode,
        cwd: rootCwd,
        model: activeModel,
        ...payload,
      });
      await appendFile(auditLogPath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      // Audit logging must never break an interactive terminal session.
    }
  };

  // Build a file list once, then filter in-memory
  const allFilesPromise = useMemo(() => {
    const MAX_ENTRIES = Number(process.env.KABLEWY_PICKER_MAX || '800');
    const MAX_DEPTH = Number(process.env.KABLEWY_PICKER_DEPTH || '2');
    const cwd = process.cwd();
    const results: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (results.length >= MAX_ENTRIES) return;
      let entries: any[] = [];
      try {
        entries = await fsReaddir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (results.length >= MAX_ENTRIES) break;
        const full = path.join(dir, ent.name);
        const rel = path.relative(cwd, full);
        if (ent.isDirectory()) {
          // include directory itself with trailing slash for visibility
          results.push(rel + '/');
          if (depth < MAX_DEPTH) {
            await walk(full, depth + 1);
          }
        } else if (ent.isFile()) {
          results.push(rel);
        }
      }
    };
    const p = (async () => {
      await walk(cwd, 0);
      return results.sort((a, b) => a.localeCompare(b));
    })();
    return p;
  }, []);

  // Open/refresh picker for a trailing @token anywhere in the input
  useEffect(() => {
    // Match the last @ token at the end of the input (until a space/enter)
    const trailingTokenRe = /@\s*("[^"]*|'[^']*|[^"'\s]*)$/;
    const m = input.match(trailingTokenRe);
    if (m) {
      setPickerOpen(true);
      const candidate = (m[1] || '').replace(/^['"]/, '');
      const needle = candidate.toLowerCase();
      allFilesPromise.then((files) => {
        const filtered = files.filter(f => f.toLowerCase().includes(needle));
        setPickerItems(filtered.slice(0, 20));
        setPickerIndex(0);
      });
    } else {
      setPickerOpen(false);
    }
  }, [input, allFilesPromise]);

  // Parse @ tokens anywhere in the text; return list and text without tokens
  const parseAttachTokensInText = (text: string): { paths: string[]; textSansTokens: string } => {
    const paths: string[] = [];
    const tokenRe = /@\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/g;
    let mm: RegExpExecArray | null;
    while ((mm = tokenRe.exec(text))) {
      const p = (mm[1] || mm[2] || mm[3] || '').replace(/\/$/, '');
      if (p) paths.push(p);
    }
    const textSansTokens = text.replace(tokenRe, '').trim();
    return { paths, textSansTokens };
  };

  useInput((inputKey, key) => {
    if (key.ctrl && inputKey === 'c') {
      onExit?.();
      exit();
    }

    if (pickerOpen) {
      if (key.upArrow) {
        setPickerIndex((i) => (i <= 0 ? 0 : i - 1));
      } else if (key.downArrow) {
        setPickerIndex((i) => (i >= Math.max(0, pickerItems.length - 1) ? Math.max(0, pickerItems.length - 1) : i + 1));
      } else if (key.return) {
        const choice = pickerItems[pickerIndex];
        if (choice) {
          // Quote if needed
          const needsQuotes = /\s/.test(choice);
          const replacement = needsQuotes ? `@ "${choice}"` : `@ ${choice}`;
          setInput(prev => prev.replace(/@\s*(?:"[^"]*"|'[^']*'|[^"'\s]*)?$/, replacement) + ' ');
          setPickerOpen(false);
          // Prevent the Enter key that closed the picker from submitting immediately
          setBlockNextSubmit(true);
        }
      } else if (key.escape) {
        setPickerOpen(false);
      }
    }

    // Shift+Tab hotkeys (toggle autorun or cycle plan)
    if (inputKey === '\t' && key.shift) {
      if (planMode) {
        // Placeholder: cycle plan steps (no-op for now)
      } else {
        setAutoRun((v) => !v);
      }
    }
  });
  const handleSlash = (text: string): boolean => {
    if (!text.startsWith('/')) return false;
    const parts = text.trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    const arg = parts[1];
    switch (cmd) {
      case '/auto-run': {
        if (arg === 'on') setAutoRun(true);
        else if (arg === 'off') setAutoRun(false);
        else if (arg === 'status') {/* no change */}
        else setAutoRun((v) => !v);
        setMessages(prev => [...prev, { role: 'tool', text: `auto-run: ${autoRun ? 'on' : 'off'}` }]);
        setInput('');
        return true;
      }
      case '/model': {
        if (arg) {
          setActiveModel(arg);
          setMessages(prev => [...prev, { role: 'tool', text: `model set: ${arg}` }]);
        } else {
          setMessages(prev => [...prev, { role: 'tool', text: `current model: ${activeModel}` }]);
        }
        setInput('');
        return true;
      }
      case '/help': {
        setMessages(prev => [...prev, { role: 'tool', text: 'slash commands: /model <name>, /auto-run [on|off|status], /new-chat, /plan, /quit. Attach files with @ path. Run shell with ! command.' }]);
        setInput('');
        return true;
      }
      case '/new-chat': {
        setMessages([]);
        setPendingAttachmentSnippets([]);
        setLastFilesAttached(0);
        setInput('');
        return true;
      }
      case '/plan': {
        setPlanMode((v) => !v);
        setInput('');
        return true;
      }
      case '/quit':
      case '/exit': {
        onExit?.();
        exit();
        return true;
      }
    }
    // Unknown slash command
    setMessages(prev => [...prev, { role: 'tool', text: `unknown command: ${cmd}. Try /help` }]);
    setInput('');
    return true;
  };

  const formatShellClassification = (classification: ShellCommandClassification): string => {
    const label = classification.risk === 'dangerous'
      ? 'Dangerous command'
      : classification.risk === 'mutating'
        ? 'Mutating command'
        : 'Read-only command';
    return [
      `${label}: ${classification.command}`,
      `Reason: ${classification.reasons.join('; ')}`,
    ].join('\n');
  };

  const prepareShellCommand = async (cmd: string): Promise<PendingShellCommand | null> => {
    const classification = classifyShellCommand(cmd);
    if (classification.usesOutsideCwd && !allowOutsideCwd) {
      const text = `${formatShellClassification(classification)}\nBlocked: command appears to leave the working directory. Re-run agent with --allow-outside-cwd to override.`;
      setMessages(prev => [...prev, { role: 'tool', text }]);
      await writeAudit('shell_blocked', { command: cmd, classification, reason: 'outside_cwd' });
      return null;
    }
    if (classification.risk === 'dangerous' && !allowDangerousShell) {
      const text = `${formatShellClassification(classification)}\nBlocked: dangerous shell commands require --allow-dangerous-shell.`;
      setMessages(prev => [...prev, { role: 'tool', text }]);
      await writeAudit('shell_blocked', { command: cmd, classification, reason: 'dangerous' });
      return null;
    }
    return { command: cmd, classification };
  };

  const executeShellCommand = async (cmd: string, summarize: boolean = true): Promise<void> => {
    const classification = classifyShellCommand(cmd);
    await writeAudit('shell_started', { command: cmd, classification });
    setPhase('Tool');
    let toolIndex = -1;
    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    setMessages(prev => {
      toolIndex = prev.length;
      return [...prev, { role: 'tool', text: `shell> ${cmd}\n` }];
    });
    const child = spawn(cmd, { shell: true, cwd: rootCwd });
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        clearTimeout(timeout);
        return true;
      };
      const appendToolChunk = (chunk: string) => {
        if (!chunk) return;
        setMessages(prev => {
          const updated = [...prev];
          const idx = Math.max(0, toolIndex);
          updated[idx] = { role: 'tool', text: updated[idx].text + chunk };
          return updated;
        });
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!finished) child.kill('SIGKILL');
        }, 2000);
      }, commandTimeoutMs);
      child.stdout.on('data', (d) => {
        const redacted = redactText(d.toString());
        const limited = takeOutputChunk(redacted, stdoutBytes, maxOutputBytes);
        stdoutBytes = limited.usedBytes;
        stdoutBuf += limited.text;
        appendToolChunk(limited.text);
        if (limited.truncated && !stdoutTruncated) {
          stdoutTruncated = true;
          appendToolChunk(`\n[stdout truncated at ${maxOutputBytes} bytes]\n`);
        }
      });
      child.stderr.on('data', (d) => {
        const redacted = redactText(d.toString());
        const limited = takeOutputChunk(redacted, stderrBytes, maxOutputBytes);
        stderrBytes = limited.usedBytes;
        stderrBuf += limited.text;
        appendToolChunk(limited.text);
        if (limited.truncated && !stderrTruncated) {
          stderrTruncated = true;
          appendToolChunk(`\n[stderr truncated at ${maxOutputBytes} bytes]\n`);
        }
      });
      child.on('error', async (error) => {
        if (!finish()) return;
        const message = `Command failed to start: ${error.message}`;
        setMessages(prev => [...prev, { role: 'assistant', text: message }]);
        await writeAudit('shell_finished', {
          command: cmd,
          classification,
          exitCode: null,
          startError: error.message,
          timedOut,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          stdoutTruncated,
          stderrTruncated,
        });
        setPhase('Idle');
        resolve();
      });
      child.on('close', async (code) => {
        if (!finish()) return;
        const exitText = timedOut
          ? `Command timed out after ${commandTimeoutMs}ms and exited with code ${code}`
          : `Command exited with code ${code}`;
        setMessages(prev => [...prev, { role: 'assistant', text: exitText }]);
        await writeAudit('shell_finished', {
          command: cmd,
          classification,
          exitCode: code,
          timedOut,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          stdoutTruncated,
          stderrTruncated,
        });

      const shouldSummarize = summarize && process.env.KABLEWY_SHELL_SUMMARY !== '0';
      if (shouldSummarize) {
        setPhase('Thinking');
        const LIMIT = Number(process.env.KABLEWY_SHELL_BYTES || '262144'); // 256KB per side
        const total = stdoutBuf + (stderrBuf ? `\n[stderr]\n${stderrBuf}` : '');
        let payload: string;
        if (total.length <= LIMIT * 2) {
          payload = [
            'Please summarize the following shell command output briefly, highlighting key results and next steps.',
            `Command: ${cmd}`,
            'Output:',
            '```',
            total,
            '```'
          ].join('\n');
        } else {
          const head = total.slice(0, LIMIT);
          const tail = total.slice(total.length - LIMIT);
          payload = [
            'Please summarize the following shell command output briefly, highlighting key results and next steps.',
            `Command: ${cmd}`,
            `Output is large (${total.length} chars). Included head and tail windows:`,
            '----- head -----',
            '```',
            head,
            '```',
            '----- tail -----',
            '```',
            tail,
            '```'
          ].join('\n');
        }
        await startStreaming(payload, [], {
          onText: (chunk: string) => {
            setPhase('Generating');
            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (!last || last.role !== 'assistant') {
                return [...prev, { role: 'assistant', text: chunk }];
              }
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', text: last.text + chunk };
              return updated;
            });
          },
          onTool: (evt: string) => setMessages(prev => [...prev, { role: 'tool', text: evt }]),
          onDone: () => setPhase('Idle')
        }, { model: activeModel });
        }
        if (!shouldSummarize) setPhase('Idle');
        resolve();
      });
    });
  };

  const doSubmit = async (forced: boolean = false) => {
    const text = input.trim();
    if (!text) return;
    if (blockNextSubmit && !forced) { setBlockNextSubmit(false); return; }
    if (pickerOpen) return; // ignore submits while picker is open

    if (pendingShellCommand) {
      const answer = text.toLowerCase();
      setInput('');
      if (['y', 'yes', 'run', 'approve'].includes(answer)) {
        const cmd = pendingShellCommand.command;
        setPendingShellCommand(null);
        await writeAudit('shell_approved', { command: cmd, classification: pendingShellCommand.classification });
        await executeShellCommand(cmd);
      } else if (['n', 'no', 'cancel', 'skip'].includes(answer)) {
        const cmd = pendingShellCommand.command;
        setPendingShellCommand(null);
        setMessages(prev => [...prev, { role: 'tool', text: `cancelled shell command: ${cmd}` }]);
        await writeAudit('shell_rejected', { command: cmd, classification: pendingShellCommand.classification });
      } else {
        setMessages(prev => [...prev, { role: 'tool', text: 'Reply y to run the pending shell command, or n to cancel it.' }]);
      }
      return;
    }

    // Slash commands
    if (text.startsWith('/')) {
      const handled = handleSlash(text);
      if (handled) return;
    }

    // ! command → run shell and stream output without calling model
    if (text.startsWith('!')) {
      const cmd = text.slice(1).trim();
      if (!cmd) return;
      setInput('');
      const pending = await prepareShellCommand(cmd);
      if (!pending) return;
      if (requireShellApproval) {
        setPendingShellCommand(pending);
        setMessages(prev => [...prev, { role: 'tool', text: `${formatShellClassification(pending.classification)}\nType y to run, n to cancel.` }]);
        await writeAudit('shell_approval_requested', { command: cmd, classification: pending.classification });
        return;
      }
      await executeShellCommand(cmd);
      return;
    }

    // Stage any @ tokens found in the input; if the message is only attachments, wait for question
    let finalUserText = text;
    const { paths, textSansTokens } = parseAttachTokensInText(text);
    let newlyStaged: string[] = [];
    if (paths.length > 0) {
      const snippets: string[] = [];
      for (const p of paths) {
        try {
          const fullPath = path.resolve(rootCwd, p);
          if (!allowOutsideCwd && !isPathInside(rootCwd, fullPath)) {
            setMessages(prev => [...prev, { role: 'tool', text: `blocked attachment outside cwd: ${p}` }]);
            await writeAudit('attachment_blocked', { path: p, reason: 'outside_cwd' });
            continue;
          }
          const st = await fsStat(fullPath);
          if (st.isDirectory()) continue; // ignore directories on submit
          const buf = await readFile(fullPath);
          const size = buf.byteLength;
          const mtime = st.mtime.toISOString();
          const DEFAULT_SIDE_BYTES = Number(process.env.KABLEWY_ATTACH_BYTES || '65536');
          if (size <= DEFAULT_SIDE_BYTES * 2) {
            snippets.push([
              '=== file:start ===',
              `path: ${path.relative(rootCwd, fullPath) || p}`,
              `size: ${size} bytes`,
              `mtime: ${mtime}`,
              'included: full',
              '----- content -----',
              '```',
              buf.toString('utf8'),
              '```',
              '=== file:end ==='
            ].join('\n'));
          } else {
            const head = buf.slice(0, Math.min(DEFAULT_SIDE_BYTES, size)).toString('utf8');
            const tail = buf.slice(Math.max(0, size - DEFAULT_SIDE_BYTES)).toString('utf8');
            snippets.push([
              '=== file:start ===',
              `path: ${path.relative(rootCwd, fullPath) || p}`,
              `size: ${size} bytes`,
              `mtime: ${mtime}`,
              `included: head[0..${DEFAULT_SIDE_BYTES - 1}], tail[-${DEFAULT_SIDE_BYTES}..end]`,
              '----- head -----',
              '```',
              head,
              '```',
              '----- tail -----',
              '```',
              tail,
              '```',
              '=== file:end ==='
            ].join('\n'));
          }
          await writeAudit('attachment_added', { path: path.relative(rootCwd, fullPath) || p, size });
        } catch (e) {
          // Non-fatal; continue
        }
      }
      if (snippets.length > 0) {
        newlyStaged = snippets;
        setPendingAttachmentSnippets((prev) => [...prev, ...snippets]);
        setLastFilesAttached((prev) => prev + snippets.length);
      }
      if (!textSansTokens) return; // wait for the question when only attachments present
    }

    // Include any staged attachments invisibly in the payload
    const allSnippets = pendingAttachmentSnippets.concat(newlyStaged);
    const attachmentsBlob = allSnippets.length > 0 ? allSnippets.join('\n\n') + '\n\n' : '';
    await writeAudit('user_message', { text: finalUserText, attachments: allSnippets.length });
    setMessages(prev => [...prev, { role: 'user', text: finalUserText }]);
    setInput('');
    setPhase('Thinking');
    let responseBuf = '';
    // Build compact role-based history from prior turns (user/assistant only)
    const allTurns = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.text }));
    const windowSize = MODEL_INPUT_WINDOW[activeModel] || 128000;
    const histFraction = Math.max(0.1, Math.min(0.9, Number(process.env.KABLEWY_HISTORY_FRACTION || '0.5')));
    const budgetTokens = Math.floor(windowSize * histFraction);
    const maxPerMsg = Number(process.env.KABLEWY_HISTORY_MSG_CHARS || '6000');
    const maxMsgsCap = Number(process.env.KABLEWY_HISTORY_MAX_MSGS || '16');
    let usedTokens = 0;
    const selected: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = allTurns.length - 1; i >= 0; i--) {
      if (selected.length >= maxMsgsCap) break;
      const raw = (allTurns[i].content || '');
      const clipped = raw.length > maxPerMsg ? raw.slice(0, maxPerMsg) : raw;
      const tok = charToToken(clipped.length);
      if (usedTokens + tok > budgetTokens) break;
      usedTokens += tok;
      selected.push({ role: allTurns[i].role, content: clipped });
    }
    const history = selected.reverse();

    await startStreaming(attachmentsBlob + finalUserText, history, {
      onText: (chunk: string) => {
        setPhase('Generating');
        responseBuf += chunk;
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (!last || last.role !== 'assistant') {
            return [...prev, { role: 'assistant', text: chunk }];
          }
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', text: last.text + chunk };
        return updated; });
        updateTokenInfo();
      },
      onTool: (evt: string) => {
        const nameMatch = /tool_call: (.+)$/i.exec(evt);
        if (nameMatch) setPhase('Tool');
        if (/tool_result/i.test(evt)) setPhase('Waiting');
        if (/tool_call: (render_artifact|apply_patch|edit|update_file|create_file)/i.test(evt)) {
          setFilesEdited((n) => n + 1);
        }
        setMessages(prev => [...prev, { role: 'tool', text: evt }]);
        updateTokenInfo();
      },
      onDone: () => setPhase('Idle')
    }, { model: activeModel });
    await writeAudit('assistant_message', { text: responseBuf });
    // Clear staged attachments after send
    setPendingAttachmentSnippets([]);
    setLastFilesAttached(0);

    // Auto-run shell commands suggested by the assistant output
    if (autoRun && responseBuf.trim()) {
      await runAutoCommands(responseBuf);
    }
  };

  const runAutoCommands = async (text: string) => {
    // Extract commands from bash code fences, lines starting with $, or lines prefixed with "Command:"
    const cmds: string[] = [];
    const fenceRe = /```(?:bash|sh)?\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(text))) {
      const block = m[1];
      for (const line of block.split(/\r?\n/)) {
        const l = line.trim();
        if (!l || l.startsWith('#')) continue;
        cmds.push(l.replace(/^\$\s+/, ''));
      }
    }
    const dollarRe = /^\$\s+(.+)$/gm;
    while ((m = dollarRe.exec(text))) cmds.push(m[1]);
    const cmdLineRe = /^Command:\s*(.+)$/gm;
    while ((m = cmdLineRe.exec(text))) cmds.push(m[1]);

    const unique = Array.from(new Set(cmds)).slice(0, 5);
    if (unique.length === 0) return;
    if (requireShellApproval) {
      const cmd = unique[0];
      const pending = await prepareShellCommand(cmd);
      if (!pending) return;
      setPendingShellCommand(pending);
      setMessages(prev => [...prev, { role: 'tool', text: `agent proposed ${unique.length} shell command(s). Approve first command?\n${formatShellClassification(pending.classification)}\nType y to run, n to cancel.` }]);
      await writeAudit('shell_approval_requested', { command: cmd, classification: pending.classification, source: 'autorun' });
      return;
    }
    setMessages(prev => [...prev, { role: 'tool', text: `auto-run: ${unique.length} command(s)` }]);
    setPhase('Tool');
    for (const cmd of unique) {
      const pending = await prepareShellCommand(cmd);
      if (pending) await executeShellCommand(cmd, false);
    }
    setPhase('Idle');
  };

  // Blinking status just above the input
  const [blinkOn, setBlinkOn] = useState<boolean>(true);
  useEffect(() => {
    if (phase === 'Idle') return;
    const id = setInterval(() => setBlinkOn(prev => !prev), 500);
    return () => clearInterval(id);
  }, [phase]);

  const StatusInline = () => (
    <Box marginTop={1} marginBottom={1}>
      <Text>
        {phase !== 'Idle' ? (
          <>
            <Text color={blinkOn ? 'green' : 'gray'}>{blinkOn ? '● ' : '○ '}</Text>
            <Text bold>
              {phase === 'Generating' ? 'Generating' : phase === 'Thinking' ? 'Thinking' : phase === 'Tool' ? 'Tool' : 'Waiting'}
            </Text>
          </>
        ) : (
          <>
            <Text color="gray">○ </Text><Text bold>Ready</Text>
          </>
        )}
      </Text>
    </Box>
  );

  const Transcript = () => (
    <Box flexDirection="column">
      {messages.map((m, i) => (
        <Box key={i} marginBottom={1}>
          {m.role === 'user' && (<Text><Text color="#00bcd4">You:</Text> {m.text}</Text>)}
          {m.role === 'assistant' && (<Text><Text color="#00e676">AI:</Text>  {m.text}</Text>)}
          {m.role === 'tool' && (<Text><Text color="#ffd54f">Tool:</Text> {m.text}</Text>)}
        </Box>
      ))}
    </Box>
  );

  const InputRow = () => (
    <Box borderStyle="single" paddingX={1} width="100%">
      <Text>→ </Text>
      <TextInput value={input} onChange={setInput} onSubmit={() => doSubmit()} placeholder="Add a follow-up" />
      <Box flexGrow={1} />
      <Text color="gray">ctrl+c to stop</Text>
    </Box>
  );

  const Picker = () => {
    if (!pickerOpen || pickerItems.length === 0) return null as any;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">attachments</Text>
        {pickerItems.map((f, idx) => (
          <Text key={f} color={idx === pickerIndex ? '#ffffff' : 'gray'}>
            {idx === pickerIndex ? '→ ' : '  '}{f}
          </Text>
        ))}
      </Box>
    );
  };

  const StagedPreview = () => {
    const { paths } = parseAttachTokensInText(input);
    if (paths.length === 0) return null as any;
    return (
      <Box marginTop={1}>
        <Text color="gray">with: {paths.join(', ')}</Text>
      </Box>
    );
  };

  const Footer = () => (
    <Box marginTop={1} flexDirection="column">
      <Text color="gray">{activeModel} · {tokenInfo} · {formatTokens(tokenCount)} tokens · {filesEdited} files edited · {lastFilesAttached} files attached</Text>
      <Text color="gray">{mode === 'agent' ? 'Kablewy Agent beta' : title} · cwd {rootCwd}</Text>
      <Text color="gray">/ commands · @ files · ! shell{requireShellApproval ? ' (approval required)' : ''}</Text>
      <Text color={autoRun ? '#ffd54f' : 'gray'}>{autoRun ? '► Auto-run proposed commands (shift+tab to turn off)' : '► Auto-run off (shift+tab to turn on)'}</Text>
      {planMode && <Text color="#64b5f6">◎ Plan (shift+tab to cycle)</Text>}
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Transcript />
      <StatusInline />
      <Box><InputRow /></Box>
      {pickerOpen && <Picker />}
      <StagedPreview />
      <Footer />
    </Box>
  );
};
