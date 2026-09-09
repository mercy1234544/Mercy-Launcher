import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  Store,
  Download,
  Search,
  CheckCircle2,
  Loader2,
  Star,
  ArrowLeft,
  ArrowLeftRight,
  Trash2,
  ExternalLink,
  Lock,
  Crown,
  LogOut,
  Shield,
  User as UserIcon,
  Wrench,
  Sparkles,
  ArrowRight,
  Server as ServerIcon,
  ShieldCheck,
  X,
  GitBranch,
  RefreshCw,
  FolderOpen,
  Package,
  AlertTriangle,
} from 'lucide-react';
import { useAppStore } from '../stores/useAppStore';
import { useAuth } from '../stores/useAuth';
import { useLocalAccess } from '../stores/useLocalAccess';
import { isSupabaseConfigured } from '../lib/supabase';
import AccountAuthModal from '../components/AccountAuthModal';

interface MarketplaceItem {
  id: string;
  name: string;
  description: string;
  author: string;
  repo: string;
  category: string;
  subcategory?: string;
  stars: number;
  installed: boolean;
  dependencies?: string[];
  version?: string;
  replaces?: string[];
  installFolder?: string;
  locked?: boolean;
  accessUrl?: string;
  premium?: boolean;
}

// Discord server for Exclusive access requests.
const DISCORD_INVITE = 'https://discord.gg/FkwnmdZx6m';

// â”€â”€â”€ MASSIVE RESOURCE CATALOG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const MARKETPLACE_ITEMS: MarketplaceItem[] = [
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // CORE / LIBRARIES
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'ox_lib', name: 'ox_lib', description: 'Shared function library with UI elements, zones, points, callbacks, and more. Required by most modern resources.',
    author: 'overextended', repo: 'https://github.com/overextended/ox_lib', category: 'Core', stars: 820, installed: false, version: '3.20.0', installFolder: '[core]',
  },
  {
    id: 'oxmysql', name: 'oxmysql', description: 'MySQL/MariaDB wrapper using node-mysql2. The standard database solution for FiveM.',
    author: 'overextended', repo: 'https://github.com/overextended/oxmysql', category: 'Core', stars: 520, installed: false, version: '2.7.6', installFolder: '[core]',
  },
  {
    id: 'mysql-async', name: 'mysql-async', description: 'Legacy MySQL wrapper for FiveM. Use oxmysql for new projects.',
    author: 'brouznouf', repo: 'https://github.com/brouznouf/fivem-mysql-async', category: 'Core', stars: 310, installed: false, replaces: ['oxmysql'], installFolder: '[core]',
  },
  {
    id: 'PolyZone', name: 'PolyZone', description: 'Zone library with polygon, circle, and box support for area detection and triggers.',
    author: 'mkafrin', repo: 'https://github.com/mkafrin/PolyZone', category: 'Core', stars: 310, installed: false, installFolder: '[core]',
  },
  {
    id: 'ox_core', name: 'ox_core', description: 'A modern FiveM framework by Overextended. Lightweight alternative to ESX/QBCore.',
    author: 'overextended', repo: 'https://github.com/overextended/ox_core', category: 'Framework', stars: 400, installed: false, version: '0.25.0', dependencies: ['ox_lib', 'oxmysql'], replaces: ['es_extended', 'qb-core'], installFolder: '[framework]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // FRAMEWORKS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-core', name: 'qb-core', description: 'QBCore Framework â€” modern, feature-rich FiveM framework for RP servers with huge community.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-core', category: 'Framework', stars: 1250, installed: false, replaces: ['es_extended', 'ox_core'], installFolder: '[framework]',
  },
  {
    id: 'es_extended', name: 'es_extended', description: 'ESX Legacy â€” the most widely used FiveM RP framework with massive community support and resources.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_core', category: 'Framework', stars: 950, installed: false, replaces: ['qb-core', 'ox_core'], installFolder: '[framework]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // VOICE
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'pma-voice', name: 'pma-voice', description: 'Full voice system with proximity chat, radio channels, phone calls, and submersion effects.',
    author: 'AvarianKnight', repo: 'https://github.com/AvarianKnight/pma-voice', category: 'Voice', stars: 420, installed: false, version: '5.0.1', replaces: ['mumble-voip', 'tokovoip'], installFolder: '[voice]',
  },
  {
    id: 'saltychat', name: 'saltychat-fivem', description: 'Salty Chat plugin for FiveM â€” TeamSpeak-based voice with 3D audio and radio simulation.',
    author: 'v10networkscom', repo: 'https://github.com/v10networkscom/saltychat-fivem', category: 'Voice', stars: 180, installed: false, replaces: ['pma-voice'], installFolder: '[voice]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // PHONE
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'npwd', name: 'npwd', description: 'New Phone Who Dis â€” React-based in-game smartphone with Twitter, messages, contacts, camera, and more.',
    author: 'project-error', repo: 'https://github.com/project-error/npwd', category: 'Phone', stars: 680, installed: false, replaces: ['qb-phone', 'gcphone', 'qs-smartphone'], installFolder: '[phone]',
  },
  {
    id: 'qb-phone', name: 'qb-phone', description: 'QBCore phone with messages, Twitter, banking app, contacts, and job center integration.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-phone', category: 'Phone', stars: 200, installed: false, dependencies: ['qb-core'], replaces: ['npwd', 'gcphone'], installFolder: '[phone]',
  },
  {
    id: 'gcphone', name: 'gcphone', description: 'Classic GCPhone â€” lightweight in-game phone with Twitter, messages, bank, and contacts.',
    author: 'GHMatti', repo: 'https://github.com/GHMatti/FiveM-GCPhone', category: 'Phone', stars: 150, installed: false, replaces: ['npwd', 'qb-phone'], installFolder: '[phone]',
  },
  {
    id: 'lb-phone', name: 'lb-phone (free)', description: 'LB Phone free/community edition â€” modern phone UI with camera, gallery, messages.',
    author: 'loljoshie', repo: 'https://github.com/loljoshie/lb-phone', category: 'Phone', stars: 120, installed: false, replaces: ['npwd', 'qb-phone', 'gcphone'], installFolder: '[phone]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // INVENTORY
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'ox_inventory', name: 'ox_inventory', description: 'Feature-rich inventory with crafting, shops, stashes, weapon attachments, and item metadata.',
    author: 'overextended', repo: 'https://github.com/overextended/ox_inventory', category: 'Inventory', stars: 730, installed: false, version: '2.37.0', dependencies: ['ox_lib', 'oxmysql'], replaces: ['qb-inventory', 'qs-inventory', 'lj-inventory'], installFolder: '[inventory]',
  },
  {
    id: 'qb-inventory', name: 'qb-inventory', description: 'QBCore inventory system with drag-and-drop, hotbar, crafting, and shop integration.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-inventory', category: 'Inventory', stars: 320, installed: false, dependencies: ['qb-core'], replaces: ['ox_inventory', 'lj-inventory'], installFolder: '[inventory]',
  },
  {
    id: 'qs-inventory', name: 'qs-inventory', description: 'Quasar Inventory â€” sleek UI with weight system, crafting, and item management.',
    author: 'quasar-store', repo: 'https://github.com/quasar-store/qs-inventory', category: 'Inventory', stars: 140, installed: false, replaces: ['ox_inventory', 'qb-inventory'], installFolder: '[inventory]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // CHARACTER / APPEARANCE
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'illenium-appearance', name: 'illenium-appearance', description: 'Modern character creator and clothing system with intuitive UI, outfits, and barber support.',
    author: 'iLLeniumStudios', repo: 'https://github.com/iLLeniumStudios/illenium-appearance', category: 'Character', stars: 450, installed: false, dependencies: ['ox_lib'], replaces: ['fivem-appearance', 'qb-clothing', 'esx_skin'], installFolder: '[character]',
  },
  {
    id: 'fivem-appearance', name: 'fivem-appearance', description: 'Standalone character creator with full body customization, tattoos, and clothing management.',
    author: 'pedr0fontoura', repo: 'https://github.com/pedr0fontoura/fivem-appearance', category: 'Character', stars: 380, installed: false, replaces: ['illenium-appearance', 'qb-clothing'], installFolder: '[character]',
  },
  {
    id: 'qb-clothing', name: 'qb-clothing', description: 'QBCore clothing and character creation with outfit saving and wardrobe system.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-clothing', category: 'Character', stars: 120, installed: false, dependencies: ['qb-core'], replaces: ['illenium-appearance', 'fivem-appearance'], installFolder: '[character]',
  },
  {
    id: 'esx_skin', name: 'esx_skin', description: 'ESX character customization â€” classic skin/clothing system for ESX servers.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_skin', category: 'Character', stars: 90, installed: false, dependencies: ['es_extended'], replaces: ['illenium-appearance', 'fivem-appearance'], installFolder: '[character]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // HUD
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'ox_hud', name: 'ox_hud', description: 'Overextended HUD â€” minimal, clean display for health, armor, hunger, thirst, and vehicle speed.',
    author: 'overextended', repo: 'https://github.com/overextended/ox_hud', category: 'HUD', stars: 160, installed: false, dependencies: ['ox_lib'], replaces: ['qb-hud', 'ps-hud', 'esx_hud'], installFolder: '[hud]',
  },
  {
    id: 'qb-hud', name: 'qb-hud', description: 'QBCore HUD with health, armor, hunger, thirst, stress, vehicle info, and compass.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-hud', category: 'HUD', stars: 180, installed: false, dependencies: ['qb-core'], replaces: ['ox_hud', 'ps-hud'], installFolder: '[hud]',
  },
  {
    id: 'ps-hud', name: 'ps-hud', description: 'Project Sloth HUD â€” modern redesign of qb-hud with cinematic bars and clean icons.',
    author: 'Project-Sloth', repo: 'https://github.com/Project-Sloth/ps-hud', category: 'HUD', stars: 220, installed: false, dependencies: ['qb-core'], replaces: ['qb-hud', 'ox_hud'], installFolder: '[hud]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // TARGETING
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'ox_target', name: 'ox_target', description: 'Performant targeting system for interacting with entities, players, vehicles, and zones.',
    author: 'overextended', repo: 'https://github.com/overextended/ox_target', category: 'Interaction', stars: 360, installed: false, version: '1.16.0', dependencies: ['ox_lib'], replaces: ['qb-target', 'bt-target'], installFolder: '[core]',
  },
  {
    id: 'qb-target', name: 'qb-target', description: 'QBCore targeting â€” eye-based interaction system for entities, zones, and models.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-target', category: 'Interaction', stars: 190, installed: false, dependencies: ['qb-core'], replaces: ['ox_target', 'bt-target'], installFolder: '[core]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ECONOMY / BANKING
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'renewed-banking', name: 'Renewed-Banking', description: 'Full banking system with ATMs, bank accounts, transfers, transaction history, and shared accounts.',
    author: 'Renewed-Scripts', repo: 'https://github.com/Renewed-Scripts/Renewed-Banking', category: 'Economy', stars: 280, installed: false, dependencies: ['ox_lib', 'oxmysql'], replaces: ['qb-banking', 'esx_banking'], installFolder: '[economy]',
  },
  {
    id: 'qb-banking', name: 'qb-banking', description: 'QBCore banking â€” ATMs and bank counters with savings accounts, transfers, and statements.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-banking', category: 'Economy', stars: 110, installed: false, dependencies: ['qb-core'], replaces: ['renewed-banking'], installFolder: '[economy]',
  },
  {
    id: 'okokBanking', name: 'okokBanking', description: 'OKOK Banking â€” clean UI for bank accounts, invoices, and transactions.',
    author: 'okok-scripts', repo: 'https://github.com/okok-scripts/okokBanking', category: 'Economy', stars: 85, installed: false, replaces: ['renewed-banking', 'qb-banking'], installFolder: '[economy]',
  },
  {
    id: 'qb-shops', name: 'qb-shops', description: 'QBCore shop system â€” configurable stores, 24/7 shops, and weapon shops with item management.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-shops', category: 'Economy', stars: 95, installed: false, dependencies: ['qb-core'], installFolder: '[economy]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // JOBS â€” POLICE
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-policejob', name: 'qb-policejob', description: 'QBCore police job with evidence, fingerprints, radar gun, spike strips, and jail integration.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-policejob', category: 'Jobs', subcategory: 'Police', stars: 200, installed: false, dependencies: ['qb-core'], replaces: ['esx_policejob'], installFolder: '[jobs]',
  },
  {
    id: 'esx_policejob', name: 'esx_policejob', description: 'ESX police job with armory, evidence locker, warrants, fines, and vehicle impound.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_policejob', category: 'Jobs', subcategory: 'Police', stars: 140, installed: false, dependencies: ['es_extended'], replaces: ['qb-policejob'], installFolder: '[jobs]',
  },
  {
    id: 'ps-mdt', name: 'ps-mdt', description: 'Project Sloth MDT â€” police/EMS mobile data terminal with warrants, BOLO, reports, and profiles.',
    author: 'Project-Sloth', repo: 'https://github.com/Project-Sloth/ps-mdt', category: 'Jobs', subcategory: 'Police', stars: 340, installed: false, dependencies: ['ox_lib'], installFolder: '[police]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // JOBS â€” EMS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-ambulancejob', name: 'qb-ambulancejob', description: 'QBCore EMS job with stretchers, bed check-in, healing items, and hospital interior.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-ambulancejob', category: 'Jobs', subcategory: 'EMS', stars: 130, installed: false, dependencies: ['qb-core'], replaces: ['esx_ambulancejob'], installFolder: '[jobs]',
  },
  {
    id: 'esx_ambulancejob', name: 'esx_ambulancejob', description: 'ESX ambulance/EMS job with hospital, revive, and medical treatment system.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_ambulancejob', category: 'Jobs', subcategory: 'EMS', stars: 95, installed: false, dependencies: ['es_extended'], replaces: ['qb-ambulancejob'], installFolder: '[jobs]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // JOBS â€” MECHANIC
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-mechanicjob', name: 'qb-mechanicjob', description: 'QBCore mechanic with vehicle repair, part replacement, tuning, and custom paint.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-mechanicjob', category: 'Jobs', subcategory: 'Mechanic', stars: 85, installed: false, dependencies: ['qb-core'], replaces: ['esx_mechanicjob'], installFolder: '[jobs]',
  },
  {
    id: 'esx_mechanicjob', name: 'esx_mechanicjob', description: 'ESX mechanic job with vehicle repair, tow truck, and parts crafting.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_mechanicjob', category: 'Jobs', subcategory: 'Mechanic', stars: 70, installed: false, dependencies: ['es_extended'], replaces: ['qb-mechanicjob'], installFolder: '[jobs]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // JOBS â€” OTHER
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-taxijob', name: 'qb-taxijob', description: 'QBCore taxi/Uber job with meter, NPC dispatch, and fare tracking.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-taxijob', category: 'Jobs', subcategory: 'Other', stars: 60, installed: false, dependencies: ['qb-core'], installFolder: '[jobs]',
  },
  {
    id: 'qb-truckerjob', name: 'qb-truckerjob', description: 'QBCore trucker job with delivery routes, cargo types, and payout scaling.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-truckerjob', category: 'Jobs', subcategory: 'Other', stars: 70, installed: false, dependencies: ['qb-core'], installFolder: '[jobs]',
  },
  {
    id: 'qb-busjob', name: 'qb-busjob', description: 'QBCore bus driver job with routes, NPC passengers, and payout system.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-busjob', category: 'Jobs', subcategory: 'Other', stars: 40, installed: false, dependencies: ['qb-core'], installFolder: '[jobs]',
  },
  {
    id: 'esx_jobs', name: 'esx_jobs', description: 'ESX generic jobs package â€” fisherman, lumberjack, miner, slaughterer, and more.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_jobs', category: 'Jobs', subcategory: 'Other', stars: 80, installed: false, dependencies: ['es_extended'], installFolder: '[jobs]',
  },
  {
    id: 'pickle-farming', name: 'pickle_farming', description: 'Farming system with planting, watering, harvesting, selling â€” great for RP economy.',
    author: 'PickleModifications', repo: 'https://github.com/PickleModifications/pickle_farming', category: 'Jobs', subcategory: 'Other', stars: 55, installed: false, installFolder: '[jobs]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // VEHICLES / GARAGES
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-garages', name: 'qb-garages', description: 'QBCore garage system with vehicle storage, impound lot, and public/job parking.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-garages', category: 'Vehicles', stars: 130, installed: false, dependencies: ['qb-core'], replaces: ['esx_garage', 'jg-advancedgarages'], installFolder: '[vehiclescripts]',
  },
  {
    id: 'qb-vehicleshop', name: 'qb-vehicleshop', description: 'QBCore vehicle dealership with test drives, financing, and employee management.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-vehicleshop', category: 'Vehicles', stars: 110, installed: false, dependencies: ['qb-core'], replaces: ['esx_vehicleshop'], installFolder: '[vehiclescripts]',
  },
  {
    id: 'qb-vehiclekeys', name: 'qb-vehiclekeys', description: 'QBCore vehicle key system â€” lockpicking, hotwiring, key sharing, and engine toggle.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-vehiclekeys', category: 'Vehicles', stars: 90, installed: false, dependencies: ['qb-core'], installFolder: '[vehiclescripts]',
  },
  {
    id: 'esx_vehicleshop', name: 'esx_vehicleshop', description: 'ESX vehicle dealer with buy/sell, test drive, and resale system.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_vehicleshop', category: 'Vehicles', stars: 75, installed: false, dependencies: ['es_extended'], replaces: ['qb-vehicleshop'], installFolder: '[vehiclescripts]',
  },
  {
    id: 'wasabi_carlock', name: 'wasabi_carlock', description: 'Standalone vehicle lock system â€” lock/unlock, alarm, hotwire, and lockpick integration.',
    author: 'wasaborern', repo: 'https://github.com/wasaborern/wasabi_carlock', category: 'Vehicles', stars: 60, installed: false, installFolder: '[vehiclescripts]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // HOUSING / PROPERTIES
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-houses', name: 'qb-houses', description: 'QBCore housing with buyable properties, stash, wardrobe, garage, and key sharing.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-houses', category: 'Housing', stars: 140, installed: false, dependencies: ['qb-core'], replaces: ['esx_property'], installFolder: '[housing]',
  },
  {
    id: 'esx_property', name: 'esx_property', description: 'ESX property system â€” buy/rent apartments and houses with stash and wardrobe.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_property', category: 'Housing', stars: 60, installed: false, dependencies: ['es_extended'], replaces: ['qb-houses'], installFolder: '[housing]',
  },
  {
    id: 'ps-housing', name: 'ps-housing', description: 'Project Sloth housing â€” modern shell-based housing with furniture placement and decorating.',
    author: 'Project-Sloth', repo: 'https://github.com/Project-Sloth/ps-housing', category: 'Housing', stars: 250, installed: false, dependencies: ['ox_lib'], replaces: ['qb-houses', 'esx_property'], installFolder: '[housing]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ADMIN TOOLS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'vMenu', name: 'vMenu', description: 'Server-side trainer/admin menu â€” teleport, vehicles, weather, player management, and permissions.',
    author: 'TomGrobbe', repo: 'https://github.com/TomGrobbe/vMenu', category: 'Admin', stars: 620, installed: false, installFolder: '[admin]',
  },
  {
    id: 'EasyAdmin', name: 'EasyAdmin', description: 'Lightweight admin system with kick, ban, spectate, teleport, and permission management.',
    author: 'Flaviocalixto', repo: 'https://github.com/Flaviocalixto/EasyAdmin', category: 'Admin', stars: 280, installed: false, installFolder: '[admin]',
  },
  {
    id: 'qb-admin', name: 'qb-adminmenu', description: 'QBCore admin menu with player management, vehicle spawning, teleport, and server tools.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-adminmenu', category: 'Admin', stars: 90, installed: false, dependencies: ['qb-core'], installFolder: '[admin]',
  },
  {
    id: 'Starter_Admin', name: 'Starter_Admin', description: 'Simple admin panel with ban, kick, warn, teleport, and player info. Great for new servers.',
    author: 'starter-scripts', repo: 'https://github.com/starter-scripts/Starter_Admin', category: 'Admin', stars: 45, installed: false, installFolder: '[admin]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // UTILITY / DOORLOCKS / MISC
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'ox_doorlock', name: 'ox_doorlock', description: 'Door management with lockpicking, authorized access, auto-lock, and admin controls.',
    author: 'overextended', repo: 'https://github.com/overextended/ox_doorlock', category: 'Utility', stars: 200, installed: false, version: '1.8.0', dependencies: ['ox_lib', 'oxmysql'], installFolder: '[utility]',
  },
  {
    id: 'qb-doorlock', name: 'qb-doorlock', description: 'QBCore door lock system with items, jobs, and gang authorization.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-doorlock', category: 'Utility', stars: 80, installed: false, dependencies: ['qb-core'], replaces: ['ox_doorlock'], installFolder: '[utility]',
  },
  {
    id: 'qb-lock', name: 'qb-lock', description: 'QBCore lockpick minigame â€” skill-based lockpicking for vehicles and doors.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-lock', category: 'Utility', stars: 55, installed: false, installFolder: '[utility]',
  },
  {
    id: 'ps-dispatch', name: 'ps-dispatch', description: 'Project Sloth dispatch â€” 911 alerts for police/EMS with location, blips, and descriptions.',
    author: 'Project-Sloth', repo: 'https://github.com/Project-Sloth/ps-dispatch', category: 'Utility', stars: 190, installed: false, dependencies: ['ox_lib'], installFolder: '[utility]',
  },
  {
    id: 'progressbar', name: 'progressbar', description: 'Simple progress bar for actions like crafting, repairing, and searching. Universal compatibility.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/progressbar', category: 'Utility', stars: 70, installed: false, installFolder: '[utility]',
  },
  {
    id: 'rpemotes', name: 'rpemotes', description: 'Massive emote menu with 400+ animations, shared emotes, prop emotes, and walk styles.',
    author: 'TayMcKenzieNZ', repo: 'https://github.com/TayMcKenzieNZ/rpemotes', category: 'Utility', stars: 350, installed: false, installFolder: '[utility]',
  },
  {
    id: 'scully_emotemenu', name: 'scully_emotemenu', description: 'Modern emote menu with search, favorites, walk styles, and prop management.',
    author: 'Scully049', repo: 'https://github.com/Scully049/scully_emotemenu', category: 'Utility', stars: 220, installed: false, dependencies: ['ox_lib'], replaces: ['rpemotes'], installFolder: '[utility]',
  },
  {
    id: 'interact-sound', name: 'interact-sound', description: 'Play custom sound files client-side â€” used by many resources for notifications and effects.',
    author: 'plunkettscoding', repo: 'https://github.com/MonkeyWhisper/interact-sound', category: 'Utility', stars: 60, installed: false, installFolder: '[utility]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // WEATHER / ENVIRONMENT
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-weathersync', name: 'qb-weathersync', description: 'Dynamic weather and time sync across all players with admin override and forecast.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-weathersync', category: 'Environment', stars: 80, installed: false, installFolder: '[environment]',
  },
  {
    id: 'cd_easytime', name: 'cd_easytime', description: 'Simple time and weather sync with commands for admins. Lightweight and standalone.',
    author: 'codesign-dev', repo: 'https://github.com/codesign-dev/cd_easytime', category: 'Environment', stars: 45, installed: false, replaces: ['qb-weathersync'], installFolder: '[environment]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MULTICHAR / SPAWN
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-multicharacter', name: 'qb-multicharacter', description: 'QBCore multi-character selection with create/delete slots and character preview.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-multicharacter', category: 'Spawn', stars: 130, installed: false, dependencies: ['qb-core'], installFolder: '[spawn]',
  },
  {
    id: 'qb-spawn', name: 'qb-spawn', description: 'QBCore spawn selector â€” choose spawn location (last position, house, apartment, job).',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-spawn', category: 'Spawn', stars: 60, installed: false, dependencies: ['qb-core'], installFolder: '[spawn]',
  },
  {
    id: 'esx_multicharacter', name: 'esx_multicharacter', description: 'ESX multi-character with character slots, creation screen, and deletion.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_multicharacter', category: 'Spawn', stars: 75, installed: false, dependencies: ['es_extended'], replaces: ['qb-multicharacter'], installFolder: '[spawn]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // NOTIFICATIONS / UI
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'ox_notify', name: 'ox_lib notifications', description: 'Built into ox_lib â€” clean notification system with types, duration, and positioning.',
    author: 'overextended', repo: 'https://github.com/overextended/ox_lib', category: 'UI', stars: 820, installed: false, installFolder: '[core]',
  },
  {
    id: 'okokNotify', name: 'okokNotify', description: 'OKOK Notifications â€” beautiful toast notifications with multiple styles and animations.',
    author: 'okok-scripts', repo: 'https://github.com/okok-scripts/okokNotify', category: 'UI', stars: 100, installed: false, installFolder: '[ui]',
  },
  {
    id: 'qb-menu', name: 'qb-menu', description: 'QBCore context menu â€” clean right-click style menu for interactions and options.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-menu', category: 'UI', stars: 70, installed: false, dependencies: ['qb-core'], installFolder: '[ui]',
  },
  {
    id: 'qb-input', name: 'qb-input', description: 'QBCore input dialog â€” configurable form inputs for player data entry.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-input', category: 'UI', stars: 50, installed: false, dependencies: ['qb-core'], installFolder: '[ui]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MLOs / MAPS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'fivem-maps-gabz', name: 'Gabz MLOs Collection', description: 'Free Gabz MLO interiors â€” police station, hospital, mechanic, and more.',
    author: 'GabzV', repo: 'https://github.com/GabzV/fivem-gabz-mapfree', category: 'MLO', stars: 350, installed: false, installFolder: '[maps]',
  },
  {
    id: 'bob74_ipl', name: 'bob74_ipl', description: 'Interior loader â€” unlock all GTA Online interiors (apartments, offices, nightclubs, bunkers).',
    author: 'Bob74', repo: 'https://github.com/Bob74/bob74_ipl', category: 'MLO', stars: 280, installed: false, installFolder: '[maps]',
  },
  {
    id: 'fivem-freecam', name: 'fivem-freecam', description: 'Free camera mode for exploring and positioning â€” useful for setting up MLOs and spawns.',
    author: 'Starter-Scripts', repo: 'https://github.com/pongo1231/fivem-freecam', category: 'MLO', stars: 70, installed: false, installFolder: '[maps]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // CRIMINAL / DRUGS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-drugs', name: 'qb-drugs', description: 'QBCore drug system â€” growing, processing, selling weed, coke, meth with animations.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-drugs', category: 'Criminal', stars: 100, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-storerobbery', name: 'qb-storerobbery', description: 'QBCore store robbery â€” register robbery, safe cracking, police alerts, and cooldowns.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-storerobbery', category: 'Criminal', stars: 80, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-bankrobbery', name: 'qb-bankrobbery', description: 'QBCore bank heist â€” thermite, hacking minigame, vault, police alerts, and loot.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-bankrobbery', category: 'Criminal', stars: 120, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-prison', name: 'qb-prison', description: 'QBCore prison system â€” jail with activities, sentence time, and commissary.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-prison', category: 'Criminal', stars: 75, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // FOOD / NEEDS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'esx_basicneeds', name: 'esx_basicneeds', description: 'ESX hunger and thirst system with consumable items and status effects.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_basicneeds', category: 'Survival', stars: 50, installed: false, dependencies: ['es_extended'], installFolder: '[standalone]',
  },
  {
    id: 'qb-smallresources', name: 'qb-smallresources', description: 'QBCore utility pack â€” seatbelts, consumables, weapon draw, and small gameplay tweaks.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-smallresources', category: 'Survival', stars: 90, installed: false, dependencies: ['qb-core'], installFolder: '[standalone]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // GANGS / FACTIONS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-gangs', name: 'qb-gangs', description: 'QBCore gang system with turf wars, gang stash, ranks, and territory control.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-gangs', category: 'Gangs', stars: 65, installed: false, dependencies: ['qb-core'], installFolder: '[gangs]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // LOADING SCREEN
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'loadingscreen', name: 'loadingscreen', description: 'Customizable loading screen with music, progress bar, server info, and rules display.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/loadingscreen', category: 'UI', stars: 65, installed: false, installFolder: '[standalone]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // RACING / FUN
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'cw-racingapp', name: 'cw-racingapp', description: 'Street racing app â€” create tracks, race with friends, leaderboards, and betting.',
    author: 'cw-scripts', repo: 'https://github.com/cw-scripts/cw-racingapp', category: 'Fun', stars: 160, installed: false, dependencies: ['ox_lib'], installFolder: '[fun]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ADDITIONAL FRAMEWORKS / CORE
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qbx_core', name: 'qbx_core', description: 'Qbox Framework â€” the next evolution of QBCore. Modern, optimized, actively maintained fork with ox_lib integration.',
    author: 'Qbox-project', repo: 'https://github.com/Qbox-project/qbx_core', category: 'Framework', stars: 380, installed: false, dependencies: ['ox_lib', 'oxmysql'], replaces: ['qb-core', 'es_extended'], installFolder: '[framework]',
  },
  {
    id: 'ox_fuel', name: 'ox_fuel', description: 'Overextended fuel system â€” realistic fuel consumption, gas stations, jerry cans, and siphoning.',
    author: 'overextended', repo: 'https://github.com/overextended/ox_fuel', category: 'Core', stars: 120, installed: false, dependencies: ['ox_lib'], replaces: ['LegacyFuel', 'cdn-fuel'], installFolder: '[core]',
  },
  {
    id: 'LegacyFuel', name: 'LegacyFuel', description: 'Classic fuel system for FiveM. Simple gas station refueling with fuel gauge.',
    author: 'InZidiux', repo: 'https://github.com/InZidiux/LegacyFuel', category: 'Core', stars: 250, installed: false, replaces: ['ox_fuel', 'cdn-fuel'], installFolder: '[core]',
  },
  {
    id: 'cdn-fuel', name: 'cdn-fuel', description: 'Modern fuel system with electric charging, fuel types, siphoning, and jerry cans.',
    author: 'CodineDev', repo: 'https://github.com/CodineDev/cdn-fuel', category: 'Core', stars: 140, installed: false, dependencies: ['ox_lib'], replaces: ['LegacyFuel', 'ox_fuel'], installFolder: '[core]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE JOBS â€” CIVILIAN / LEGAL
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-newsjob', name: 'qb-newsjob', description: 'QBCore news/reporter job â€” camera, microphone, boom mic, news van, and live broadcasts.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-newsjob', category: 'Jobs', stars: 55, installed: false, dependencies: ['qb-core'], installFolder: '[jobs]',
  },
  {
    id: 'qb-recyclejob', name: 'qb-recyclejob', description: 'QBCore recycling job â€” collect recyclables, process materials, earn money.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-recyclejob', category: 'Jobs', stars: 35, installed: false, dependencies: ['qb-core'], installFolder: '[jobs]',
  },
  {
    id: 'qb-garbagejob', name: 'qb-garbagejob', description: 'QBCore garbage truck job â€” drive routes, collect trash, earn payouts.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-garbagejob', category: 'Jobs', stars: 50, installed: false, dependencies: ['qb-core'], installFolder: '[jobs]',
  },
  {
    id: 'qb-towjob', name: 'qb-towjob', description: 'QBCore tow truck job â€” flatbed towing, vehicle impound, and NPC callouts.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-towjob', category: 'Jobs', stars: 45, installed: false, dependencies: ['qb-core'], installFolder: '[jobs]',
  },
  {
    id: 'esx_dmvschool', name: 'esx_dmvschool', description: 'ESX driving school â€” theory test and practical driving exam for license acquisition.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_dmvschool', category: 'Jobs', stars: 55, installed: false, dependencies: ['es_extended'], installFolder: '[jobs]',
  },
  {
    id: 'pickle_mining', name: 'pickle_mining', description: 'Mining job â€” mine ores, smelt metals, sell refined materials. Great economy loop.',
    author: 'PickleModifications', repo: 'https://github.com/PickleModifications/pickle_mining', category: 'Jobs', stars: 45, installed: false, installFolder: '[jobs]',
  },
  {
    id: 'pickle_fishing', name: 'pickle_fishing', description: 'Fishing system â€” cast rod, catch fish, sell at market. Minigame-based with rare catches.',
    author: 'PickleModifications', repo: 'https://github.com/PickleModifications/pickle_fishing', category: 'Jobs', stars: 40, installed: false, installFolder: '[jobs]',
  },
  {
    id: 'pickle_hunting', name: 'pickle_hunting', description: 'Hunting system â€” track animals, hunt, skin, sell pelts. Realistic with zones.',
    author: 'PickleModifications', repo: 'https://github.com/PickleModifications/pickle_hunting', category: 'Jobs', stars: 38, installed: false, installFolder: '[jobs]',
  },
  {
    id: 'esx_godirtyjob', name: 'esx_godirtyjob', description: 'ESX street cleaning job â€” pick up trash around the city with a van for money.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_godirtyjob', category: 'Jobs', stars: 30, installed: false, dependencies: ['es_extended'], installFolder: '[jobs]',
  },
  {
    id: 'qb-diving', name: 'qb-diving', description: 'QBCore scuba diving job â€” dive for treasure, coral, and underwater loot.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-diving', category: 'Jobs', stars: 30, installed: false, dependencies: ['qb-core'], installFolder: '[jobs]',
  },
  {
    id: 'qb-vineyard', name: 'qb-vineyard', description: 'QBCore vineyard job â€” pick grapes, stomp wine, barrel aging, sell bottles.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-vineyard', category: 'Jobs', stars: 35, installed: false, dependencies: ['qb-core'], installFolder: '[jobs]',
  },
  {
    id: 'esx_firemanager', name: 'esx_firemanager', description: 'Fire department job â€” respond to fire calls, use hose, rescue civilians, fire truck.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_firemanager', category: 'Jobs', subcategory: 'EMS', stars: 40, installed: false, dependencies: ['es_extended'], installFolder: '[jobs]',
  },
  {
    id: 'ps-realtor', name: 'ps-realtor', description: 'Project Sloth realtor job â€” sell properties to players, manage listings, earn commission.',
    author: 'Project-Sloth', repo: 'https://github.com/Project-Sloth/ps-realtor', category: 'Jobs', stars: 45, installed: false, dependencies: ['ox_lib'], installFolder: '[jobs]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE CRIMINAL / HEISTS / DRUGS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-houserobbery', name: 'qb-houserobbery', description: 'QBCore house robbery â€” break into NPC houses, search drawers, steal valuables, fence loot.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-houserobbery', category: 'Criminal', stars: 90, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-jewelery', name: 'qb-jewelery', description: 'QBCore jewelry store heist â€” smash display cases, grab loot, escape before cops arrive.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-jewelery', category: 'Criminal', stars: 75, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-pawnshop', name: 'qb-pawnshop', description: 'QBCore pawn shop â€” sell stolen goods, fence jewelry, dispose of dirty money.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-pawnshop', category: 'Criminal', stars: 55, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-lapraces', name: 'qb-lapraces', description: 'QBCore illegal street racing â€” setup races, bet money, race for pinks.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-lapraces', category: 'Criminal', stars: 50, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-streetdealer', name: 'qb-streetdealer', description: 'QBCore street dealer â€” sell drugs to NPCs at random locations, risk police encounters.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-streetdealer', category: 'Criminal', stars: 45, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-weed', name: 'qb-weed', description: 'QBCore weed growing â€” plant, water, harvest, dry, package, and sell. Full drug cycle.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-weed', category: 'Criminal', stars: 60, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-methlab', name: 'qb-methlab', description: 'QBCore meth lab â€” cook meth with chemical ingredients, risk explosions, sell product.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-methlab', category: 'Criminal', stars: 55, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-cocaine', name: 'qb-cocaine', description: 'QBCore cocaine processing â€” harvest coca, process into coke, package, distribute.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-cocaine', category: 'Criminal', stars: 50, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-chopshop', name: 'qb-chopshop', description: 'QBCore chop shop â€” steal cars, deliver to chop shop, strip parts for cash.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-chopshop', category: 'Criminal', stars: 65, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-boosting', name: 'qb-boosting', description: 'QBCore vehicle boosting â€” steal marked vehicles, deliver for VIN scratch, earn crypto.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-boosting', category: 'Criminal', stars: 70, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'esx_drugs', name: 'esx_drugs', description: 'ESX drug system â€” grow, process, and sell weed, cocaine, meth, and opium.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_drugs', category: 'Criminal', stars: 65, installed: false, dependencies: ['es_extended'], installFolder: '[criminal]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE ECONOMY / SHOPS / BUSINESS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-atm', name: 'qb-atm', description: 'QBCore ATM robbery â€” hack ATMs for cash, risk police alert, cooldown timers.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-atm', category: 'Economy', stars: 40, installed: false, dependencies: ['qb-core'], installFolder: '[economy]',
  },
  {
    id: 'qb-blackmarket', name: 'qb-blackmarket', description: 'QBCore black market â€” buy illegal weapons, items, and equipment from shady NPCs.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-blackmarket', category: 'Economy', stars: 45, installed: false, dependencies: ['qb-core'], installFolder: '[economy]',
  },
  {
    id: 'esx_billing', name: 'esx_billing', description: 'ESX billing system â€” send invoices between players, society bills, and fine system.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_billing', category: 'Economy', stars: 55, installed: false, dependencies: ['es_extended'], installFolder: '[economy]',
  },
  {
    id: 'okokMarketplace', name: 'okokMarketplace', description: 'OKOK player marketplace â€” list items for sale, browse and buy from other players.',
    author: 'okok-scripts', repo: 'https://github.com/okok-scripts/okokMarketplace', category: 'Economy', stars: 40, installed: false, installFolder: '[economy]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE VEHICLES / GARAGE / FUEL
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'jg-advancedgarages', name: 'jg-advancedgarages', description: 'Advanced garage with vehicle preview, impound, transfer, parking spots, and clean UI.',
    author: 'JoeSzymkowiczFiveworx', repo: 'https://github.com/JoeSzymkowiczFiveworx/jg-advancedgarages', category: 'Vehicles', stars: 180, installed: false, dependencies: ['ox_lib'], replaces: ['qb-garages'], installFolder: '[vehiclescripts]',
  },
  {
    id: 'renewed-vehiclekeys', name: 'Renewed-Vehiclekeys', description: 'Modern vehicle key system â€” lockpick, hotwire, give keys, alarm system.',
    author: 'Renewed-Scripts', repo: 'https://github.com/Renewed-Scripts/Renewed-Vehiclekeys', category: 'Vehicles', stars: 130, installed: false, dependencies: ['ox_lib'], replaces: ['qb-vehiclekeys'], installFolder: '[vehiclescripts]',
  },
  {
    id: 'brz-vehiclehandling', name: 'brz-vehiclehandling', description: 'Realistic vehicle handling â€” tire pressure, brake fade, turbo lag, and suspension physics.',
    author: 'Starter-Scripts', repo: 'https://github.com/bryzz-fivem/brz-vehiclehandling', category: 'Vehicles', stars: 45, installed: false, installFolder: '[vehiclescripts]',
  },
  {
    id: 'qb-carwash', name: 'qb-carwash', description: 'QBCore car wash â€” drive in, pay, watch your car get cleaned with animations.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-carwash', category: 'Vehicles', stars: 30, installed: false, dependencies: ['qb-core'], installFolder: '[vehiclescripts]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE INVENTORY / CRAFTING
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-crafting', name: 'qb-crafting', description: 'QBCore crafting system â€” craft weapons, attachments, drugs, and items at workbenches.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-crafting', category: 'Inventory', stars: 65, installed: false, dependencies: ['qb-core'], installFolder: '[inventory]',
  },
  {
    id: 'ps-inventory', name: 'ps-inventory', description: 'Project Sloth inventory â€” modern redesign of qb-inventory with improved UI and performance.',
    author: 'Project-Sloth', repo: 'https://github.com/Project-Sloth/ps-inventory', category: 'Inventory', stars: 180, installed: false, dependencies: ['ox_lib'], replaces: ['qb-inventory', 'ox_inventory'], installFolder: '[inventory]',
  },
  {
    id: 'core_inventory', name: 'core_inventory', description: 'Core Inventory â€” clean, performant inventory with crafting, shops, and stashes.',
    author: 'core-framework', repo: 'https://github.com/core-framework/core_inventory', category: 'Inventory', stars: 70, installed: false, replaces: ['ox_inventory', 'qb-inventory'], installFolder: '[inventory]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE HOUSING / PROPERTIES
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'bcs_housing', name: 'bcs_housing', description: 'Shell-based housing with furniture placement, interior customization, and stash system.',
    author: 'Starter-Scripts', repo: 'https://github.com/BCS-Scripts/bcs_housing', category: 'Housing', stars: 60, installed: false, replaces: ['qb-houses', 'ps-housing'], installFolder: '[housing]',
  },
  {
    id: 'qb-apartments', name: 'qb-apartments', description: 'QBCore apartments â€” starter apartments with stash, wardrobe, and logout point.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-apartments', category: 'Housing', stars: 55, installed: false, dependencies: ['qb-core'], installFolder: '[housing]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE GANGS / FACTIONS / TURF
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'wasabi_gangs', name: 'wasabi_gangs', description: 'Gang management with turf wars, stash houses, gang vehicles, spray tags, and ranks.',
    author: 'wasaborern', repo: 'https://github.com/wasaborern/wasabi_gangs', category: 'Gangs', stars: 80, installed: false, replaces: ['qb-gangs'], installFolder: '[gangs]',
  },
  {
    id: 'qb-gangmenu', name: 'qb-gangmenu', description: 'QBCore gang menu â€” manage members, ranks, gang stash, and vehicle access.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-gangmenu', category: 'Gangs', stars: 40, installed: false, dependencies: ['qb-core'], installFolder: '[gangs]',
  },
  {
    id: 'qb-spraypaint', name: 'qb-spraypaint', description: 'QBCore spray paint â€” tag territory with gang colors, mark turf, crew graffiti.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-spraypaint', category: 'Gangs', stars: 35, installed: false, dependencies: ['qb-core'], installFolder: '[gangs]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE ENVIRONMENT / WEATHER / WORLD
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'vSync', name: 'vSync', description: 'Versatile time and weather sync â€” supports dynamic weather, time speed, and smooth transitions.',
    author: 'VenomXNL', repo: 'https://github.com/VenomXNL/vSync', category: 'Environment', stars: 55, installed: false, replaces: ['qb-weathersync', 'cd_easytime'], installFolder: '[environment]',
  },
  {
    id: 'realistic-damage', name: 'realistic-damage', description: 'Realistic vehicle and player damage â€” engine failure, tire blowouts, limping, and bleeding.',
    author: 'N0Mercy', repo: 'https://github.com/N0Mercy/realistic-vehicle-damage', category: 'Environment', stars: 60, installed: false, installFolder: '[environment]',
  },
  {
    id: 'qb-streetlights', name: 'qb-streetlights', description: 'Controllable street lights â€” blackout zones, shooting out lights, repair system.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-streetlights', category: 'Environment', stars: 25, installed: false, installFolder: '[environment]',
  },
  {
    id: 'pma-nui', name: 'pma-nui', description: 'Cinematic NUI bars â€” add movie-style black bars for cutscenes and RP moments.',
    author: 'AvarianKnight', repo: 'https://github.com/AvarianKnight/pma-nui', category: 'Environment', stars: 20, installed: false, installFolder: '[environment]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE UI / NOTIFICATIONS / MENUS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-radialmenu', name: 'qb-radialmenu', description: 'QBCore radial menu â€” hold Z for quick access to actions, vehicle controls, and emotes.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-radialmenu', category: 'UI', stars: 75, installed: false, dependencies: ['qb-core'], installFolder: '[ui]',
  },
  {
    id: 'qb-scoreboard', name: 'qb-scoreboard', description: 'QBCore scoreboard â€” show online players, IDs, ping, and server info.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-scoreboard', category: 'UI', stars: 35, installed: false, dependencies: ['qb-core'], installFolder: '[ui]',
  },
  {
    id: 'okokTextUI', name: 'okokTextUI', description: 'OKOK Text UI â€” clean floating text prompts for interactions and contextual hints.',
    author: 'okok-scripts', repo: 'https://github.com/okok-scripts/okokTextUI', category: 'UI', stars: 50, installed: false, installFolder: '[ui]',
  },
  {
    id: 'qb-drawtext', name: 'qb-drawtext', description: 'QBCore draw text UI â€” on-screen text prompts for interactions, 3D text labels.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-drawtext', category: 'UI', stars: 40, installed: false, installFolder: '[ui]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE MLOs / MAPS / INTERIORS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'fivem-map-hipster', name: 'Hipster Barber MLO', description: 'Custom barber shop interior with hipster theme â€” chairs, mirrors, props, and lighting.',
    author: 'community', repo: 'https://github.com/Starter-FiveM/hipster-barber-mlo', category: 'MLO', stars: 30, installed: false, installFolder: '[mlo]',
  },
  {
    id: 'cfx-doorcontrol', name: 'cfx-doorcontrol', description: 'Native door control system â€” lock/unlock any door in the game without doorlock scripts.',
    author: 'cfx', repo: 'https://github.com/citizenfx/cfx-server-data', category: 'MLO', stars: 150, installed: false, installFolder: '[maps]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE CHARACTER / APPEARANCE / CLOTHING
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-tattoos', name: 'qb-tattoos', description: 'QBCore tattoo shop â€” browse and apply tattoos by body part with preview and pricing.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-tattoos', category: 'Character', stars: 40, installed: false, dependencies: ['qb-core'], installFolder: '[character]',
  },
  {
    id: 'qb-barber', name: 'qb-barber', description: 'QBCore barber shop â€” change hair style, color, beard, eyebrows, and face features.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-barber', category: 'Character', stars: 35, installed: false, dependencies: ['qb-core'], installFolder: '[character]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE FUN / ACTIVITIES / ENTERTAINMENT
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-casino', name: 'qb-casino', description: 'QBCore casino â€” blackjack, roulette, slot machines, and poker at Diamond Casino.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-casino', category: 'Fun', stars: 55, installed: false, dependencies: ['qb-core'], installFolder: '[fun]',
  },
  {
    id: 'ps-bowling', name: 'ps-bowling', description: 'Project Sloth bowling â€” fully playable bowling alleys with scoring and multiplayer.',
    author: 'Project-Sloth', repo: 'https://github.com/Project-Sloth/ps-bowling', category: 'Fun', stars: 45, installed: false, dependencies: ['ox_lib'], installFolder: '[fun]',
  },
  {
    id: 'ps-golf', name: 'ps-golf', description: 'Project Sloth golf â€” playable golf course with clubs, scoring, and multiplayer rounds.',
    author: 'Project-Sloth', repo: 'https://github.com/Project-Sloth/ps-golf', category: 'Fun', stars: 40, installed: false, dependencies: ['ox_lib'], installFolder: '[fun]',
  },
  {
    id: 'qb-paintball', name: 'qb-paintball', description: 'QBCore paintball â€” team deathmatch arena with scoring, loadouts, and matchmaking.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-paintball', category: 'Fun', stars: 35, installed: false, dependencies: ['qb-core'], installFolder: '[fun]',
  },
  {
    id: 'doj-hunting', name: 'doj-hunting', description: 'Hunting system with animal tracking, weapons, skinning, and trophy mounts.',
    author: 'DOJ-scripts', repo: 'https://github.com/DOJ-scripts/doj-hunting', category: 'Fun', stars: 30, installed: false, installFolder: '[fun]',
  },
  {
    id: 'cinema', name: 'cinema', description: 'In-game cinema â€” watch synced YouTube videos on theater screens with other players.',
    author: 'xander1998', repo: 'https://github.com/xander1998/fivem-cinema', category: 'Fun', stars: 50, installed: false, installFolder: '[fun]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE UTILITY / QOL / GAMEPLAY
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-deathscreen', name: 'qb-deathscreen', description: 'QBCore death screen â€” timer, respawn options, and EMS notification on death.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-deathscreen', category: 'Utility', stars: 35, installed: false, dependencies: ['qb-core'], installFolder: '[utility]',
  },
  {
    id: 'qb-loading', name: 'qb-loading', description: 'QBCore loading screen with server branding, rules, and changelog.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-loading', category: 'Utility', stars: 30, installed: false, installFolder: '[utility]',
  },
  {
    id: 'qb-fitbit', name: 'qb-fitbit', description: 'QBCore fitness tracker â€” track walking, running, and swimming with health bonuses.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-fitbit', category: 'Utility', stars: 25, installed: false, dependencies: ['qb-core'], installFolder: '[utility]',
  },
  {
    id: 'qb-commandbinding', name: 'qb-commandbinding', description: 'QBCore key binding â€” bind any command to a key for quick access.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-commandbinding', category: 'Utility', stars: 20, installed: false, installFolder: '[utility]',
  },
  {
    id: 'qb-weapons', name: 'qb-weapons', description: 'QBCore weapon system â€” durability, serial numbers, attachments, and tint system.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-weapons', category: 'Utility', stars: 55, installed: false, dependencies: ['qb-core'], installFolder: '[utility]',
  },
  {
    id: 'ps-camera', name: 'ps-camera', description: 'Project Sloth camera â€” take in-game photos, selfie mode, gallery, and social media upload.',
    author: 'Project-Sloth', repo: 'https://github.com/Project-Sloth/ps-camera', category: 'Utility', stars: 40, installed: false, dependencies: ['ox_lib'], installFolder: '[utility]',
  },
  {
    id: 'qb-weedplanting', name: 'qb-weedplanting', description: 'QBCore placeable weed plants â€” plant anywhere, water, fertilize, harvest, avoid police.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-weedplanting', category: 'Criminal', stars: 45, installed: false, dependencies: ['qb-core'], installFolder: '[criminal]',
  },
  {
    id: 'qb-handcuffs', name: 'qb-handcuffs', description: 'QBCore handcuff system â€” cuff/uncuff players, escort, and pat down for police RP.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-handcuffs', category: 'Utility', stars: 30, installed: false, dependencies: ['qb-core'], installFolder: '[utility]',
  },
  {
    id: 'wasabi_bridge', name: 'wasabi_bridge', description: 'Framework bridge â€” make resources work across QBCore, ESX, and Qbox without code changes.',
    author: 'wasaborern', repo: 'https://github.com/wasaborern/wasabi_bridge', category: 'Core', stars: 90, installed: false, installFolder: '[core]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE SPAWN / MULTICHAR
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'esx_identity', name: 'esx_identity', description: 'ESX identity system â€” character name, date of birth, gender, height, and ID card.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_identity', category: 'Spawn', stars: 50, installed: false, dependencies: ['es_extended'], installFolder: '[spawn]',
  },
  {
    id: 'ps-multicharacter', name: 'ps-multicharacter', description: 'Project Sloth multicharacter â€” modern character selection with 3D preview and animations.',
    author: 'Project-Sloth', repo: 'https://github.com/Project-Sloth/ps-multicharacter', category: 'Spawn', stars: 60, installed: false, dependencies: ['ox_lib'], replaces: ['qb-multicharacter'], installFolder: '[spawn]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE SURVIVAL / NEEDS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'qb-cooking', name: 'qb-cooking', description: 'QBCore cooking system â€” craft food and drinks at kitchens for hunger/thirst needs.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-cooking', category: 'Survival', stars: 35, installed: false, dependencies: ['qb-core'], installFolder: '[standalone]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MORE HUD
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'esx_hud', name: 'esx_hud', description: 'ESX HUD â€” health, armor, hunger, thirst, and job display for ESX servers.',
    author: 'esx-framework', repo: 'https://github.com/esx-framework/esx_hud', category: 'HUD', stars: 40, installed: false, dependencies: ['es_extended'], replaces: ['qb-hud', 'ps-hud', 'ox_hud'], installFolder: '[hud]',
  },
  {
    id: 'qb-minimap', name: 'qb-minimap', description: 'QBCore custom minimap â€” circle minimap with borders, compass heading, and street names.',
    author: 'qbcore-framework', repo: 'https://github.com/qbcore-framework/qb-minimap', category: 'HUD', stars: 30, installed: false, installFolder: '[hud]',
  },

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // EXCLUSIVE / PREMIUM â€” Advances Collection
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  {
    id: 'AdvancesAdmin', name: 'AdvancesAdmin', description: 'Premium role-based admin menu for Qbox servers with cyberpunk NUI. God mode, noclip, spectate, teleport, vehicle spawn, weather control, report system, and 30+ permission nodes across 4 staff tiers.',
    author: 'Advances', repo: '', category: 'Exclusive', stars: 0, installed: false, version: '1.0.0',
    dependencies: ['qbx_core', 'ox_lib'], installFolder: '[admin]',
    locked: true, premium: true,
    accessUrl: DISCORD_INVITE,
  },
  {
    id: 'AdvancesWeather', name: 'AdvancesWeather', description: 'Premium dynamic weather & environment dashboard for Qbox. Server-synced weather, snow mode, blackout, 11 disaster events (earthquakes, tornadoes, tsunamis), emergency broadcasts, glassmorphism UI, and live forecast.',
    author: 'Advances', repo: '', category: 'Exclusive', stars: 0, installed: false, version: '1.0.0',
    dependencies: ['qbx_core'], installFolder: '[environment]',
    locked: true, premium: true,
    accessUrl: DISCORD_INVITE,
  },
];

// Exclusive (locked) scripts — the ones the Admin Panel grants access to.
export const EXCLUSIVE_ITEMS: { id: string; name: string }[] =
  MARKETPLACE_ITEMS.filter((i) => i.locked).map((i) => ({ id: i.id, name: i.name }));

// Repos verified missing/private/moved on GitHub (they 404 on install). Audited
// 2026-07 — hidden from the store so users never hit a failed "not found"
// install. Fix a URL here (remove it from the set) to bring an item back.
const DEAD_REPOS = new Set<string>([
  'https://github.com/AvarianKnight/pma-nui',
  'https://github.com/BCS-Scripts/bcs_housing',
  'https://github.com/DOJ-scripts/doj-hunting',
  'https://github.com/Flaviocalixto/EasyAdmin',
  'https://github.com/GHMatti/FiveM-GCPhone',
  'https://github.com/GabzV/fivem-gabz-mapfree',
  'https://github.com/InZidiux/LegacyFuel',
  'https://github.com/JoeSzymkowiczFiveworx/jg-advancedgarages',
  'https://github.com/MonkeyWhisper/interact-sound',
  'https://github.com/N0Mercy/realistic-vehicle-damage',
  'https://github.com/PickleModifications/pickle_fishing',
  'https://github.com/PickleModifications/pickle_hunting',
  'https://github.com/PickleModifications/pickle_mining',
  'https://github.com/Project-Sloth/ps-bowling',
  'https://github.com/Project-Sloth/ps-golf',
  'https://github.com/Project-Sloth/ps-multicharacter',
  'https://github.com/Renewed-Scripts/Renewed-Vehiclekeys',
  'https://github.com/Scully049/scully_emotemenu',
  'https://github.com/Starter-FiveM/hipster-barber-mlo',
  'https://github.com/TayMcKenzieNZ/rpemotes',
  'https://github.com/VenomXNL/vSync',
  'https://github.com/bryzz-fivem/brz-vehiclehandling',
  'https://github.com/codesign-dev/cd_easytime',
  'https://github.com/core-framework/core_inventory',
  'https://github.com/cw-scripts/cw-racingapp',
  'https://github.com/esx-framework/esx_ambulancejob',
  'https://github.com/esx-framework/esx_basicneeds',
  'https://github.com/esx-framework/esx_billing',
  'https://github.com/esx-framework/esx_dmvschool',
  'https://github.com/esx-framework/esx_drugs',
  'https://github.com/esx-framework/esx_firemanager',
  'https://github.com/esx-framework/esx_godirtyjob',
  'https://github.com/esx-framework/esx_hud',
  'https://github.com/esx-framework/esx_identity',
  'https://github.com/esx-framework/esx_jobs',
  'https://github.com/esx-framework/esx_mechanicjob',
  'https://github.com/esx-framework/esx_multicharacter',
  'https://github.com/esx-framework/esx_policejob',
  'https://github.com/esx-framework/esx_property',
  'https://github.com/esx-framework/esx_skin',
  'https://github.com/esx-framework/esx_vehicleshop',
  'https://github.com/loljoshie/lb-phone',
  'https://github.com/okok-scripts/okokBanking',
  'https://github.com/okok-scripts/okokMarketplace',
  'https://github.com/okok-scripts/okokNotify',
  'https://github.com/okok-scripts/okokTextUI',
  'https://github.com/overextended/ox_hud',
  'https://github.com/pongo1231/fivem-freecam',
  'https://github.com/qbcore-framework/loadingscreen',
  'https://github.com/qbcore-framework/qb-atm',
  'https://github.com/qbcore-framework/qb-barber',
  'https://github.com/qbcore-framework/qb-blackmarket',
  'https://github.com/qbcore-framework/qb-boosting',
  'https://github.com/qbcore-framework/qb-carwash',
  'https://github.com/qbcore-framework/qb-casino',
  'https://github.com/qbcore-framework/qb-chopshop',
  'https://github.com/qbcore-framework/qb-cocaine',
  'https://github.com/qbcore-framework/qb-commandbinding',
  'https://github.com/qbcore-framework/qb-cooking',
  'https://github.com/qbcore-framework/qb-deathscreen',
  'https://github.com/qbcore-framework/qb-drawtext',
  'https://github.com/qbcore-framework/qb-fitbit',
  'https://github.com/qbcore-framework/qb-gangmenu',
  'https://github.com/qbcore-framework/qb-gangs',
  'https://github.com/qbcore-framework/qb-handcuffs',
  'https://github.com/qbcore-framework/qb-lock',
  'https://github.com/qbcore-framework/qb-methlab',
  'https://github.com/qbcore-framework/qb-minimap',
  'https://github.com/qbcore-framework/qb-paintball',
  'https://github.com/qbcore-framework/qb-spraypaint',
  'https://github.com/qbcore-framework/qb-streetdealer',
  'https://github.com/qbcore-framework/qb-streetlights',
  'https://github.com/qbcore-framework/qb-tattoos',
  'https://github.com/qbcore-framework/qb-weedplanting',
  'https://github.com/quasar-store/qs-inventory',
  'https://github.com/starter-scripts/Starter_Admin',
  'https://github.com/wasaborern/wasabi_bridge',
  'https://github.com/wasaborern/wasabi_carlock',
  'https://github.com/wasaborern/wasabi_gangs',
  'https://github.com/xander1998/fivem-cinema',
]);

// Store shows only installable items (exclusives keep their empty repo).
const AVAILABLE_ITEMS = MARKETPLACE_ITEMS.filter((i) => !i.repo || !DEAD_REPOS.has(i.repo));

const categoryColors: Record<string, string> = {
  Core: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  Framework: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  Voice: 'bg-green-500/20 text-green-300 border-green-500/30',
  Inventory: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  Utility: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  Phone: 'bg-pink-500/20 text-pink-300 border-pink-500/30',
  Character: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  Economy: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  Jobs: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  Vehicles: 'bg-red-500/20 text-red-300 border-red-500/30',
  Housing: 'bg-teal-500/20 text-teal-300 border-teal-500/30',
  Admin: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  HUD: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
  Interaction: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  MLO: 'bg-lime-500/20 text-lime-300 border-lime-500/30',
  Criminal: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
  Survival: 'bg-stone-500/20 text-stone-300 border-stone-500/30',
  Spawn: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30',
  UI: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
  Environment: 'bg-green-600/20 text-green-200 border-green-600/30',
  Gangs: 'bg-red-600/20 text-red-200 border-red-600/30',
  Fun: 'bg-pink-600/20 text-pink-200 border-pink-600/30',
  Exclusive: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
};

/** Matches FiveMMarketplace.ts's own parseRepoUrl() — kept in sync manually
 *  since main/renderer are separate TS projects that can't share this tiny
 *  helper directly. Used only to compare a catalog item's repo URL against
 *  an installed-content record's "owner/repo" for "is this installed?". */
function repoSlug(repoUrl: string): string | null {
  const m = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)\/?$/i);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : null;
}
function githubPreviewImage(repoUrl: string): string | null {
  const slug = repoSlug(repoUrl);
  return slug ? `https://opengraph.githubassets.com/1/${slug}` : null;
}

export default function Marketplace() {
  const navigate = useNavigate();
  const { activeServerId, servers, logAction } = useAppStore();
  const [items] = useState(AVAILABLE_ITEMS);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('all');
  const [installing, setInstalling] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<{ pct: number; message: string } | null>(null);
  // Exclusive item the user is requesting access to (ticket-style modal).
  const [accessItem, setAccessItem] = useState<MarketplaceItem | null>(null);
  // Real detail view — live GitHub data fetched only when opened.
  const [detailItem, setDetailItem] = useState<MarketplaceItem | null>(null);
  const [detailData, setDetailData] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Which server Marketplace installs are targeting — defaults to whatever
  // is already "active" elsewhere in Mercy, but is always an explicit,
  // visible choice here so a resource is never installed into the wrong
  // server by accident.
  const [targetServerId, setTargetServerId] = useState(activeServerId || '');
  const targetServer = servers.find((s) => s.id === targetServerId) || null;

  // Real installed-state for the CURRENT target server — never a local
  // "installed: true" flag that resets on reload. Re-fetched whenever the
  // target server changes or an install/remove completes.
  const [installedContent, setInstalledContent] = useState<FiveMInstalledContent[]>([]);
  const refreshInstalled = () => {
    if (!targetServerId) { setInstalledContent([]); return; }
    window.electronAPI.fivemMarketplace.listInstalled(targetServerId).then(setInstalledContent).catch(() => setInstalledContent([]));
  };
  useEffect(refreshInstalled, [targetServerId]);

  const installedRecordFor = (item: MarketplaceItem) => {
    const slug = item.repo ? repoSlug(item.repo) : null;
    return slug ? installedContent.find((c) => c.repo === slug) : undefined;
  };

  // Account system — per-script access via Supabase. The login UI only appears
  // once accounts are configured; pre-setup the store behaves as before.
  const { profile, entitlements, signOut } = useAuth();
  const localGranted = useLocalAccess((s) => s.granted);
  const redeem = useLocalAccess((s) => s.redeem);
  const accountsOn = isSupabaseConfigured();
  const [authOpen, setAuthOpen] = useState(false);
  const [redeemCode, setRedeemCode] = useState('');
  const isAdmin = profile?.role === 'admin' || profile?.role === 'owner';

  // Unlocked via a real account entitlement OR a local (no-database) admin unlock.
  const hasAccessTo = (item: MarketplaceItem) => entitlements.includes(item.id) || localGranted.includes(item.id);

  const requestMessage = (item: MarketplaceItem) =>
    [
      `🎫 Access Request — ${item.name}`,
      `Script: ${item.name}${item.version ? ` v${item.version}` : ''}`,
      profile ? `App username: ${profile.username}` : `App username: (not logged in — please make an account)`,
      `From: FiveM Server Builder store`,
      ``,
      `Hi! I'd like access to this exclusive script. Please grant it to my username above.`,
    ].join('\n');

  const copyRequest = (item: MarketplaceItem) => {
    navigator.clipboard.writeText(requestMessage(item));
    toast.success('Request message copied — paste it in your ticket');
  };

  const sortedCategories = [...new Set(items.map(i => i.category))].sort();
  const categories = ['all', ...sortedCategories];

  const installItem = async (item: MarketplaceItem) => {
    if (!targetServer) { toast.error('Select a server first'); return; }
    if (!item.repo) { toast.error('This item has no installable source yet.'); return; }

    // A resource this item replaces gets removed first, for real, if it's
    // genuinely installed on this target server (not just assumed).
    const replacedRecords = (item.replaces || [])
      .map((id) => { const catalogItem = items.find((i) => i.id === id); return catalogItem ? installedRecordFor(catalogItem) : undefined; })
      .filter((r): r is FiveMInstalledContent => !!r);

    setInstalling(item.id);
    const cleanup = window.electronAPI.onFiveMMarketplaceInstallProgress(setInstallProgress);
    try {
      for (const replaced of replacedRecords) {
        await window.electronAPI.fivemMarketplace.removeResource(targetServer.id, replaced.id);
      }
      const result = await window.electronAPI.fivemMarketplace.install(targetServer.id, {
        repoUrl: item.repo, resourceName: item.name, category: item.installFolder || '[standalone]', dependencies: item.dependencies,
      });
      if (!result.success) throw new Error(result.error || 'Installation failed');

      refreshInstalled();
      if (replacedRecords.length > 0) {
        logAction('Resource Replaced', `${replacedRecords.map((r) => r.resourceName).join(', ')} → ${item.name}`, 'success');
        toast.success(`${item.name} installed, replaced ${replacedRecords.map((r) => r.resourceName).join(', ')}`);
      } else {
        logAction('Resource Installed', `${item.name} from marketplace`, 'success');
        toast.success(`${item.name} installed successfully`);
      }
    } catch (e: any) {
      toast.error(e.message || 'Installation failed');
      logAction('Install Failed', `${item.name}: ${e.message}`, 'error');
    } finally {
      cleanup?.();
      setInstalling(null);
      setInstallProgress(null);
    }
  };

  const uninstallItem = async (item: MarketplaceItem) => {
    if (!targetServer) return;
    const record = installedRecordFor(item);
    if (!record) return;
    setInstalling(item.id);
    try {
      const result = await window.electronAPI.fivemMarketplace.removeResource(targetServer.id, record.id);
      if (!result.success) throw new Error(result.error);
      refreshInstalled();
      logAction('Resource Removed', item.name, 'info');
      toast.success(`${item.name} removed`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to remove resource');
    } finally {
      setInstalling(null);
    }
  };

  const openDetail = async (item: MarketplaceItem) => {
    setDetailItem(item);
    setDetailData(null);
    if (!item.repo) return;
    setDetailLoading(true);
    try { setDetailData(await window.electronAPI.fivemMarketplace.repoDetails(item.repo)); }
    catch { /* keep the catalog's own description/author as a fallback below */ }
    finally { setDetailLoading(false); }
  };

  const filtered = items.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(search.toLowerCase()) ||
      item.description.toLowerCase().includes(search.toLowerCase()) ||
      item.author.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = filterCategory === 'all' || item.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  const installedCount = installedContent.length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6 p-6 max-w-7xl mx-auto"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>
          <div>
            <h1 className="text-2xl font-bold text-surface-100">FiveM Marketplace</h1>
            <p className="text-sm text-surface-400 mt-1">
              {filtered.length} scripts &amp; resources · {installedCount} installed{targetServer ? ` on ${targetServer.name}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Account controls — only shown once accounts are configured */}
          {accountsOn && (
            profile ? (
              <>
                {isAdmin && (
                  <button
                    onClick={() => navigate('/admin')}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary-500/15 text-primary-300 border border-primary-500/30 rounded-lg hover:bg-primary-500/25 transition-all"
                    title="Open the Admin Panel"
                  >
                    <Shield size={12} /> Admin Panel
                  </button>
                )}
                <span className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-overlay-4 text-surface-200 border border-overlay-6 rounded-lg">
                  {profile.role === 'owner' ? <Crown size={12} className="text-amber-400" /> : <UserIcon size={12} />} {profile.username}
                </span>
                <button
                  onClick={() => { signOut(); toast('Logged out'); }}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 bg-overlay-4 text-surface-400 border border-overlay-6 rounded-lg hover:text-surface-100 hover:bg-overlay-6 transition-all"
                  title="Log out"
                >
                  <LogOut size={12} />
                </button>
              </>
            ) : (
              <button
                onClick={() => setAuthOpen(true)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary-600 text-white border border-primary-500/40 rounded-lg hover:bg-primary-500 transition-all"
                title="Log in or create an account to access Exclusive scripts"
              >
                <Lock size={12} /> Log in / Sign up
              </button>
            )
          )}
        </div>
      </div>

      <AccountAuthModal open={authOpen} onClose={() => setAuthOpen(false)} />

      {/* Explicit install target — never assumed, so a resource can't land
          on the wrong server. Shows the same at-a-glance info Minecraft's
          Marketplace does: name, status, framework, location. */}
      <div className="flex items-center gap-3 p-3 rounded-2xl border border-overlay-6 bg-overlay-3">
        <ServerIcon size={16} className="text-surface-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-surface-500">Installing for</p>
          <select value={targetServerId} onChange={(e) => setTargetServerId(e.target.value)} className="input-field text-sm py-1.5 mt-0.5">
            <option value="">Browse only (choose a server to enable installing)</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>{s.name} — {s.framework === 'qbcore' ? 'QBCore' : s.framework === 'esx' ? 'ESX' : s.framework} · {s.status} · {s.installPath}</option>
            ))}
          </select>
        </div>
        {targetServer && (
          <span className="text-[11px] text-surface-500 flex items-center gap-1.5 shrink-0"><ShieldCheck size={13} className="text-success" /> Installs go into this server only</span>
        )}
      </div>

      {/* ═══ UY Framework — Coming Soon banner ═══ */}
      <div className="relative overflow-hidden rounded-2xl border border-primary-500/30 bg-gradient-to-br from-primary-600/20 via-[#0c0f1c] to-surface-950 p-6">
        <div className="absolute -top-16 -right-16 w-56 h-56 rounded-full bg-primary-500/20 blur-3xl pointer-events-none" />
        <div className="relative flex flex-col md:flex-row md:items-center gap-5">
          <div className="w-14 h-14 rounded-2xl bg-primary-500/20 border border-primary-500/30 flex items-center justify-center shrink-0">
            <Wrench size={26} className="text-primary-300" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">🚧 IN DEVELOPMENT</span>
              <span className="text-[10px] font-bold text-surface-500 uppercase tracking-wider">Coming Soon</span>
            </div>
            <h2 className="text-xl font-extrabold text-surface-100 flex items-center gap-2">UY Framework <Sparkles size={16} className="text-primary-300" /></h2>
            <p className="text-sm text-surface-300 mt-1 leading-relaxed max-w-2xl">
              A completely original FiveM framework, built from the ground up for performance, clean code, and a premium experience.
              Every major system researched, designed, and built from scratch — with previews shared as they're finished.
            </p>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {['Character Creator', 'Inventory', 'Third Eye', 'HUD', 'Player Systems', 'Jobs'].map((t) => (
                <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-overlay-4 text-surface-300 border border-overlay-6">{t}</span>
              ))}
            </div>
          </div>
          <button
            onClick={() => window.electronAPI?.openExternal(DISCORD_INVITE)}
            className="shrink-0 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold bg-primary-600 text-white hover:bg-primary-500 transition-all"
          >
            Previews in Discord <ArrowRight size={15} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            type="text"
            className="input-field pl-9"
            placeholder="Search resources, authors, descriptions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Category pills â€” scrollable */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setFilterCategory(cat)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
              filterCategory === cat
                ? 'bg-primary-600 text-surface-100'
                : 'bg-surface-800 text-surface-300 hover:bg-surface-700'
            }`}
          >
            {cat === 'all' ? `All (${items.length})` : `${cat} (${items.filter(i => i.category === cat).length})`}
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((item, i) => {
          const installedRecord = installedRecordFor(item);
          const previewImg = item.repo ? githubPreviewImage(item.repo) : null;
          return (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.02, 0.5) }}
            className={`card flex flex-col group cursor-pointer ${item.premium ? 'border-amber-500/30 hover:border-amber-400/50 hover:shadow-[0_0_20px_rgba(245,158,11,0.1)]' : 'hover:border-surface-500/50'}`}
            onClick={() => openDetail(item)}
          >
            {previewImg && (
              <div className="-mx-4 -mt-4 mb-3 h-28 rounded-t-xl overflow-hidden bg-overlay-4">
                <img src={previewImg} alt="" className="w-full h-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              </div>
            )}
            <div className="flex items-start justify-between mb-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-surface-100 truncate group-hover:text-primary-300 transition-colors">{item.name}</h3>
                  {item.premium && (
                    <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-gradient-to-r from-amber-500/20 to-yellow-500/20 border border-amber-500/40 rounded text-amber-300 shrink-0 font-semibold">
                      <Crown size={8} />
                      EXCLUSIVE
                    </span>
                  )}
                  {item.version && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-surface-700 rounded text-surface-400 shrink-0">
                      v{item.version}
                    </span>
                  )}
                </div>
                <p className="text-xs text-surface-400">{item.author}</p>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ml-2 ${
                categoryColors[item.category] || 'bg-surface-700/50 text-surface-300 border-surface-600'
              }`}>
                {item.category}
              </span>
            </div>

            <p className="text-xs text-surface-300 flex-1 leading-relaxed line-clamp-3">{item.description}</p>

            {item.dependencies && item.dependencies.length > 0 && (
              <div className="flex items-center gap-1 mt-2 flex-wrap">
                <span className="text-[10px] text-surface-500">Requires:</span>
                {item.dependencies.map(dep => (
                  <span key={dep} className="text-[10px] px-1.5 py-0.5 bg-surface-800 rounded text-surface-400">{dep}</span>
                ))}
              </div>
            )}

            {item.replaces && item.replaces.length > 0 && (
              <div className="flex items-center gap-1 mt-1 flex-wrap">
                <ArrowLeftRight size={10} className="text-surface-500" />
                <span className="text-[10px] text-surface-500">Replaces: {item.replaces.join(', ')}</span>
              </div>
            )}

            <div className="flex items-center justify-between mt-3 pt-3 border-t border-surface-700/50">
              <div className="flex items-center gap-1.5">
                {item.premium ? (
                  <Crown size={12} className="text-amber-400" />
                ) : (
                  <Star size={12} className="text-amber-400" />
                )}
                <span className="text-xs text-surface-400">
                  {item.premium ? 'Premium' : item.stars.toLocaleString()}
                </span>
              </div>
              {item.locked && hasAccessTo(item) ? (
                item.repo ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); installItem(item); }}
                    disabled={installing === item.id || !targetServer}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-medium text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    title={!targetServer ? 'Select a server first' : 'Access granted to your account — install'}
                  >
                    {installing === item.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    Install
                  </button>
                ) : (
                  <span className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/15 border border-emerald-500/30 rounded-lg text-xs font-medium text-emerald-300"
                    title="Access granted to your account — download source not wired up for this item yet">
                    <CheckCircle2 size={12} /> Access granted
                  </span>
                )
              ) : item.locked ? (
                <button
                  onClick={(e) => { e.stopPropagation(); setAccessItem(item); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/40 rounded-lg text-xs font-medium text-amber-300 transition-all cursor-pointer"
                  title="Open an access request"
                >
                  <Lock size={12} />
                  Request Access
                  <ExternalLink size={10} className="opacity-60" />
                </button>
              ) : installedRecord ? (
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-xs text-green-400 font-medium">
                    <CheckCircle2 size={14} />
                    Installed
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); uninstallItem(item); }}
                    disabled={installing === item.id}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-red-400 bg-red-500/10 rounded hover:bg-red-500/20 transition-colors"
                  >
                    {installing === item.id ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                    Remove
                  </button>
                </div>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); installItem(item); }}
                  disabled={installing === item.id || !targetServer || !item.repo}
                  title={!targetServer ? 'Select a server first' : !item.repo ? 'No installable source for this item yet' : undefined}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-600 hover:bg-primary-500 rounded-lg text-xs font-medium text-surface-100 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {installing === item.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Download size={12} />
                  )}
                  Install
                </button>
              )}
            </div>
          </motion.div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12">
          <Store size={40} className="text-surface-600 mx-auto mb-3" />
          <p className="text-surface-400">No resources match your search</p>
        </div>
      )}

      {installing && installProgress && (
        <div className="fixed bottom-6 right-6 z-40 w-80 rounded-2xl border border-overlay-10 bg-surface-900 p-4 shadow-2xl">
          <div className="flex items-center justify-between mb-2 text-xs"><span className="text-surface-300 truncate">{installProgress.message}</span><span className="text-surface-500 shrink-0 ml-2">{installProgress.pct}%</span></div>
          <div className="w-full h-1.5 bg-overlay-6 rounded-full overflow-hidden"><div className="h-full bg-primary-500 transition-all" style={{ width: `${installProgress.pct}%` }} /></div>
        </div>
      )}

      {/* ═══ Content Details modal — real, live GitHub data + real image ═══ */}
      <AnimatePresence>
        {detailItem && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={() => setDetailItem(null)}>
            <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} onClick={(e) => e.stopPropagation()}
              className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl bg-surface-900 border border-overlay-10">
              {detailItem.repo && githubPreviewImage(detailItem.repo) && (
                <div className="h-40 w-full overflow-hidden rounded-t-2xl bg-overlay-4">
                  <img src={githubPreviewImage(detailItem.repo)!} alt="" className="w-full h-full object-cover" />
                </div>
              )}
              <div className="p-6 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-base font-bold text-surface-100">{detailItem.name}</p>
                      {detailItem.version && <span className="text-[11px] px-1.5 py-0.5 bg-surface-700 rounded text-surface-400">v{detailItem.version}</span>}
                    </div>
                    <p className="text-xs text-surface-500">by {detailItem.author} · <span className={`px-1.5 py-0.5 rounded-full border ${categoryColors[detailItem.category] || ''}`}>{detailItem.category}</span></p>
                  </div>
                  <button onClick={() => setDetailItem(null)} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6"><X size={16} /></button>
                </div>

                {detailLoading ? (
                  <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-primary-400" /></div>
                ) : (
                  <>
                    <p className="text-sm text-surface-300">{detailData?.description || detailItem.description}</p>
                    {detailData && (
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div className="flex items-center gap-1.5 text-surface-400"><Star size={12} className="text-amber-400" /> {detailData.stars.toLocaleString()} stars</div>
                        <div className="flex items-center gap-1.5 text-surface-400"><GitBranch size={12} /> {detailData.defaultBranch}</div>
                        {detailData.license && <div className="flex items-center gap-1.5 text-surface-400 col-span-2">License: {detailData.license.name}</div>}
                        <div className="flex items-center gap-1.5 text-surface-400 col-span-2">Last updated: {new Date(detailData.pushedAt).toLocaleDateString()}</div>
                      </div>
                    )}
                    {!detailItem.repo && (
                      <p className="text-xs text-surface-500 flex items-center gap-1.5"><Lock size={12} /> No public source — this is an exclusive item.</p>
                    )}
                    {detailItem.repo && (
                      <button onClick={() => window.electronAPI?.openExternal(detailItem.repo)} className="text-xs text-primary-400 hover:underline flex items-center gap-1.5"><ExternalLink size={12} /> View source on GitHub</button>
                    )}
                    {detailItem.dependencies && detailItem.dependencies.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold text-surface-400 mb-1.5">Dependencies</p>
                        <div className="flex flex-wrap gap-1.5">
                          {detailItem.dependencies.map((dep) => {
                            const depItem = items.find((i) => i.id === dep || i.name === dep);
                            const depInstalled = depItem ? !!installedRecordFor(depItem) : false;
                            return (
                              <span key={dep} className={`text-[11px] px-2 py-1 rounded-lg border flex items-center gap-1.5 ${depInstalled ? 'border-success/30 bg-success-bg text-success' : 'border-overlay-8 bg-overlay-4 text-surface-400'}`}>
                                {depInstalled ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />} {dep} {depItem ? (depInstalled ? '(installed)' : '(missing)') : '(not in catalog)'}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center gap-2 pt-2">
                      {!targetServer ? (
                        <p className="text-xs text-surface-500 flex items-center gap-1.5"><ServerIcon size={13} /> Select a server above to install this.</p>
                      ) : installedRecordFor(detailItem) ? (
                        <button onClick={() => { uninstallItem(detailItem); setDetailItem(null); }} className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5"><Trash2 size={13} /> Remove from {targetServer.name}</button>
                      ) : detailItem.repo ? (
                        <button onClick={() => { installItem(detailItem); setDetailItem(null); }} disabled={!!installing} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"><Download size={13} /> Install to {targetServer.name}</button>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══ Request Access modal — ticket-style flow via Discord ═══ */}
      <AnimatePresence>
        {accessItem && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md"
            onClick={() => setAccessItem(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.92, y: 16 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              className="glass-panel p-6 max-w-md w-full mx-4"
            >
              <div className="flex items-start gap-3 mb-4">
                <div className="w-11 h-11 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                  <Crown size={19} className="text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-surface-100 truncate">Request Access — {accessItem.name}</h3>
                  <p className="text-xs text-surface-400 mt-0.5">Exclusive script · access is granted through a Discord ticket</p>
                </div>
                <button onClick={() => setAccessItem(null)} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-all">
                  ✕
                </button>
              </div>

              {/* Have a code? — redeem an unlock code an admin gave you. */}
              {!accountsOn && (
                <div className="rounded-xl border border-primary-500/30 bg-primary-500/10 p-3 mb-4">
                  <p className="text-xs font-bold text-primary-200 mb-2">Have a code?</p>
                  <div className="flex gap-2">
                    <input
                      value={redeemCode}
                      onChange={(e) => setRedeemCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        if (redeem(accessItem.id, redeemCode)) { toast.success(`${accessItem.name} unlocked!`); setRedeemCode(''); setAccessItem(null); }
                        else toast.error('That code isn’t valid for this script.');
                      }}
                      placeholder="e.g. HB4704" spellCheck={false}
                      className="flex-1 bg-[#0d1117] border border-overlay-6 rounded-lg px-3 py-2 text-sm font-mono tracking-widest text-surface-100 placeholder-surface-600 focus:outline-none focus:border-primary-500/40"
                    />
                    <button
                      onClick={() => {
                        if (redeem(accessItem.id, redeemCode)) { toast.success(`${accessItem.name} unlocked!`); setRedeemCode(''); setAccessItem(null); }
                        else toast.error('That code isn’t valid for this script.');
                      }}
                      className="px-4 py-2 rounded-lg text-xs font-bold bg-primary-600 text-white hover:bg-primary-500 transition-all"
                    >
                      Redeem
                    </button>
                  </div>
                </div>
              )}

              {/* Fast path: if Discord login is set up and they already have the
                  role, one click unlocks — no ticket needed. */}
              {accountsOn && (
                profile ? (
                  <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 mb-4">
                    <p className="text-xs text-emerald-200 leading-snug">
                      You're logged in as <span className="font-bold">{profile.username}</span>. Open a ticket with your
                      username and an admin will grant access — it unlocks here automatically.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-primary-500/30 bg-primary-500/10 p-3 mb-4 flex items-center justify-between gap-3">
                    <p className="text-xs text-primary-200 leading-snug">Make an account first so we can grant access to your username.</p>
                    <button
                      onClick={() => { setAccessItem(null); setAuthOpen(true); }}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-primary-600 text-white hover:bg-primary-500 transition-all"
                    >
                      <Lock size={12} /> Log in / Sign up
                    </button>
                  </div>
                )
              )}

              {/* How to request access — join Discord, open a ticket */}
              <div className="space-y-2.5 mb-4">
                {[
                  { n: 1, text: <>Join the Discord server</> },
                  { n: 2, text: <>Make a ticket in <span className="text-amber-300 font-semibold">FiveM Server Builder Exclusive Scripts</span></> },
                  { n: 3, text: <>Paste your request message (below) into the ticket</> },
                ].map((s) => (
                  <div key={s.n} className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded-full bg-primary-600/20 border border-primary-500/30 text-primary-300 text-[11px] font-bold flex items-center justify-center shrink-0">{s.n}</span>
                    <p className="text-sm text-surface-300">{s.text}</p>
                  </div>
                ))}
              </div>

              {/* Pre-filled request message */}
              <div className="rounded-xl border border-overlay-6 bg-[#0d1117] p-3 mb-4">
                <p className="text-[10px] uppercase tracking-wider text-surface-500 mb-1.5">Your request message</p>
                <pre className="text-[11px] text-surface-300 whitespace-pre-wrap font-mono leading-relaxed">{requestMessage(accessItem)}</pre>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => copyRequest(accessItem)}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold bg-overlay-6 text-surface-200 hover:bg-overlay-10 border border-overlay-8 transition-all"
                >
                  Copy message
                </button>
                <button
                  onClick={() => {
                    copyRequest(accessItem);
                    window.electronAPI?.openExternal(accessItem.accessUrl || DISCORD_INVITE);
                  }}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold bg-primary-600 text-white hover:bg-primary-500 transition-all"
                >
                  <ExternalLink size={13} /> Join Discord &amp; Request
                </button>
              </div>
              <p className="text-[10px] text-surface-600 mt-3 text-center">
                The message is copied automatically — open a ticket and paste it (Ctrl+V).
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
