import React, { useState, useEffect, useMemo } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { spawn } from 'child_process';
import { readFile, stat as fsStat, readdir as fsReaddir } from 'fs/promises';
import path from 'path';

type Message = { role: 'user' | 'assistant' | 'tool'; text: string };

export type InkChatProps = {
  title?: string;
  model?: string;
  onExit?: () => void;
  startStreaming: (
    text: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    handlers: { onText: (chunk: string) => void; onTool: (evt: string) => void; onDone: () => void }
  ) => Promise<void>;
};

export function runInkChat(ui: React.ReactElement) {
  return render(ui);
}

export const InkChat: React.FC<InkChatProps> = ({ title = 'Kablewy Chat', model = 'gpt-5.4', onExit, startStreaming }) => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<'Thinking' | 'Tool' | 'Waiting' | 'Generating' | 'Idle'>('Idle');
  const [tokenInfo, setTokenInfo] = useState<string>('0.0%');
  const [tokenCount, setTokenCount] = useState<number>(0);
  const [filesEdited, setFilesEdited] = useState<number>(0);
  const [lastFilesAttached, setLastFilesAttached] = useState<number>(0);
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
    const windowSize = MODEL_INPUT_WINDOW[model] || 128000;
    const pct = Math.min(100, (estimate / windowSize) * 100);
    setTokenInfo(`${pct.toFixed(1)}%`);
    setTokenCount(estimate);
  };

  useEffect(() => {
    updateTokenInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, input, pendingAttachmentSnippets]);

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
          // Note: model prop is read-only; store in a message banner for now
          setMessages(prev => [...prev, { role: 'tool', text: `model set: ${arg}` }]);
        } else {
          setMessages(prev => [...prev, { role: 'tool', text: `current model: ${model}` }]);
        }
        setInput('');
        return true;
      }
      case '/help': {
        setMessages(prev => [...prev, { role: 'tool', text: 'slash commands: /model <name>, /auto-run [on|off|status], /new-chat, /plan, /quit' }]);
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

  const doSubmit = async (forced: boolean = false) => {
    const text = input.trim();
    if (!text) return;
    if (blockNextSubmit && !forced) { setBlockNextSubmit(false); return; }
    if (pickerOpen) return; // ignore submits while picker is open

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
      setPhase('Tool');
      let toolIndex = -1;
      let stdoutBuf = '';
      let stderrBuf = '';
      setMessages(prev => {
        toolIndex = prev.length;
        return [...prev, { role: 'tool', text: `shell> ${cmd}\n` }];
      });
      const child = spawn(cmd, { shell: true });
      child.stdout.on('data', (d) => {
        const chunk = d.toString();
        stdoutBuf += chunk;
        setMessages(prev => {
          const updated = [...prev];
          const idx = Math.max(0, toolIndex);
          updated[idx] = { role: 'tool', text: updated[idx].text + chunk };
          return updated;
        });
      });
      child.stderr.on('data', (d) => {
        const chunk = d.toString();
        stderrBuf += chunk;
        setMessages(prev => {
          const updated = [...prev];
          const idx = Math.max(0, toolIndex);
          updated[idx] = { role: 'tool', text: updated[idx].text + chunk };
          return updated;
        });
      });
      child.on('close', async (code) => {
        setMessages(prev => [...prev, { role: 'assistant', text: `Command exited with code ${code}` }]);

        // Auto-summarize shell output using the model unless disabled
        const shouldSummarize = process.env.KABLEWY_SHELL_SUMMARY !== '0';
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
          });
        }
        if (!shouldSummarize) setPhase('Idle');
      });
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
          const st = await fsStat(p);
          if (st.isDirectory()) continue; // ignore directories on submit
          const buf = await readFile(p);
          const size = buf.byteLength;
          const mtime = st.mtime.toISOString();
          const DEFAULT_SIDE_BYTES = Number(process.env.KABLEWY_ATTACH_BYTES || '65536');
          if (size <= DEFAULT_SIDE_BYTES * 2) {
            snippets.push([
              '=== file:start ===',
              `path: ${p}`,
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
              `path: ${p}`,
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
    setMessages(prev => [...prev, { role: 'user', text: finalUserText }]);
    setInput('');
    setPhase('Thinking');
    let responseBuf = '';
    // Build compact role-based history from prior turns (user/assistant only)
    const allTurns = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.text }));
    const windowSize = MODEL_INPUT_WINDOW[model] || 128000;
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
    });
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
    setMessages(prev => [...prev, { role: 'tool', text: `auto-run: ${unique.length} command(s)` }]);
    setPhase('Tool');
    for (const cmd of unique) {
      await runOneCommand(cmd);
    }
    setPhase('Idle');
  };

  const runOneCommand = async (cmd: string) => {
    return new Promise<void>((resolve) => {
      let toolIndex = -1;
      setMessages(prev => { toolIndex = prev.length; return [...prev, { role: 'tool', text: `shell> ${cmd}\n` }]; });
      const child = spawn(cmd, { shell: true });
      child.stdout.on('data', (d) => {
        const chunk = d.toString();
        setMessages(prev => { const updated = [...prev]; updated[toolIndex] = { role: 'tool', text: updated[toolIndex].text + chunk }; return updated; });
      });
      child.stderr.on('data', (d) => {
        const chunk = d.toString();
        setMessages(prev => { const updated = [...prev]; updated[toolIndex] = { role: 'tool', text: updated[toolIndex].text + chunk }; return updated; });
      });
      child.on('close', (code) => {
        setMessages(prev => [...prev, { role: 'assistant', text: `Command exited with code ${code}` }]);
        resolve();
      });
    });
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
      <Text color="gray">{model} · {tokenInfo} · {formatTokens(tokenCount)} tokens · {filesEdited} files edited · {lastFilesAttached} files attached</Text>
      <Text color="gray">/ commands · @ files · ! shell · ctrl+r to review edits</Text>
      <Text color={autoRun ? '#ffd54f' : 'gray'}>{autoRun ? '► Auto-run all commands (shift+tab to turn off)' : '► Auto-run off (shift+tab to turn on)'}</Text>
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


