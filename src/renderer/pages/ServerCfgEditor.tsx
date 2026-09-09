import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  FileCode,
  Save,
  RotateCcw,
  AlertTriangle,
  CheckCircle2,
  ArrowLeft,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';

export default function ServerCfgEditor() {
  const navigate = useNavigate();
  const { activeServerId, servers } = useAppStore();
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [validationIssues, setValidationIssues] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeServer = servers.find(s => s.id === activeServerId);

  useEffect(() => {
    if (activeServer) loadCfg();
  }, [activeServerId]);

  useEffect(() => {
    setHasChanges(content !== originalContent);
    validate(content);
  }, [content]);

  const loadCfg = async () => {
    if (!activeServer || !window.electronAPI) return;
    try {
      const result = await window.electronAPI.file.readFile(`${activeServer.installPath}\\server.cfg`);
      if (result) {
        setContent(result.content);
        setOriginalContent(result.content);
      }
    } catch {
      toast.error('Failed to load server.cfg');
    }
  };

  const save = async () => {
    if (!activeServer || !window.electronAPI) return;
    try {
      // Backup before save
      const backupPath = `${activeServer.installPath}\\server.cfg.backup`;
      await window.electronAPI.file.writeFile(backupPath, originalContent);

      await window.electronAPI.file.writeFile(`${activeServer.installPath}\\server.cfg`, content);
      setOriginalContent(content);
      setHasChanges(false);
      toast.success('Saved server.cfg');
    } catch {
      toast.error('Failed to save');
    }
  };

  const revert = () => {
    setContent(originalContent);
  };

  const validate = (text: string) => {
    const issues: string[] = [];
    if (text.includes('changeme')) {
      issues.push('License key is still set to "changeme"');
    }
    if (!text.includes('endpoint_add_tcp')) {
      issues.push('Missing TCP endpoint configuration');
    }
    if (!text.includes('endpoint_add_udp')) {
      issues.push('Missing UDP endpoint configuration');
    }
    setValidationIssues(issues);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newContent = content.substring(0, start) + '  ' + content.substring(end);
      setContent(newContent);
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }, 0);
    }
  };

  if (!activeServer) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full">
        <FileCode size={48} className="text-surface-600 mb-4" />
        <p className="text-surface-400">Select a server to edit server.cfg</p>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4 h-full flex flex-col"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
        <div>
          <h1 className="text-2xl font-bold text-surface-100">Server.cfg Editor</h1>
          <p className="text-sm text-surface-400 mt-1">
            {activeServer.name}
            {hasChanges && <span className="text-amber-400 ml-2">Â· Unsaved changes</span>}
          </p>
        </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={revert}
            disabled={!hasChanges}
            className="btn-secondary flex items-center gap-2 disabled:opacity-50"
          >
            <RotateCcw size={16} />
            Revert
          </button>
          <button
            onClick={save}
            disabled={!hasChanges}
            className="btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            <Save size={16} />
            Save
          </button>
        </div>
      </div>

      {/* Validation */}
      {validationIssues.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {validationIssues.map((issue, i) => (
            <span key={i} className="flex items-center gap-1 px-2 py-1 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-300">
              <AlertTriangle size={12} />
              {issue}
            </span>
          ))}
        </div>
      )}

      {validationIssues.length === 0 && content && (
        <div className="flex items-center gap-1 text-xs text-green-400">
          <CheckCircle2 size={12} />
          Configuration looks good
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 min-h-0">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full h-full p-4 bg-surface-900 border border-surface-700 rounded-xl text-sm font-mono text-surface-200 resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 leading-relaxed"
          spellCheck={false}
          placeholder="# server.cfg content will appear here..."
        />
      </div>

      <div className="flex justify-between text-xs text-surface-500">
        <span>Ctrl+S to save Â· Tab for indent</span>
        <span>{content.split('\n').length} lines</span>
      </div>
    </motion.div>
  );
}
