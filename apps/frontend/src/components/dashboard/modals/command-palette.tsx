"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Search,
  LayoutDashboard,
  Package,
  Users,
  SendHorizontal,
  Code2,
  UsersRound,
  Gift,
  Globe,
  Link2,
  UserCog,
  Plus,
  Upload,
  Copy,
  Check,
  ArrowRight,
  Sparkles,
  Command,
  X,
  CreditCard,
  Wallet,
} from "lucide-react";
import { DashboardTab } from "../dashboard-types";
import { MerchantUser } from "@/lib/auth-context";

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateTab: (tab: DashboardTab) => void;
  onOpenCreatePlan: () => void;
  onDisbursePayroll: () => void;
  onCopySettlementAddress: () => void;
  user: MerchantUser;
}

interface CommandItem {
  id: string;
  label: string;
  category: "Actions" | "Navigation" | "Plans" | "Subscribers";
  description?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  action: () => void;
  keywords?: string[];
}

export function CommandPalette({
  isOpen,
  onClose,
  onNavigateTab,
  onOpenCreatePlan,
  onDisbursePayroll,
  onCopySettlementAddress,
  user,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  // Store previous active element to restore focus on exit
  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement;
      setQuery("");
      setSelectedIndex(0);
      // Small timeout to ensure DOM is ready for focus
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    } else {
      if (previousActiveElement.current && typeof previousActiveElement.current.focus === "function") {
        previousActiveElement.current.focus();
      }
    }
  }, [isOpen]);

  const allCommands = useMemo<CommandItem[]>(() => {
    const settlementAddress = user.linkedVaults?.stellar || user.walletAddress || "";
    const shortAddress = settlementAddress ? `${settlementAddress.slice(0, 6)}...${settlementAddress.slice(-4)}` : "No address linked";

    return [
      // Quick Actions
      {
        id: "action-create-plan",
        label: "Create New Plan",
        category: "Actions",
        description: "Configure pricing tiers, billing cycles, and USDC rates",
        icon: Plus,
        action: () => {
          onClose();
          onOpenCreatePlan();
        },
        keywords: ["new", "create", "plan", "subscription", "price", "tier"],
      },
      {
        id: "action-disburse-payroll",
        label: "Disburse Payroll",
        category: "Actions",
        description: "Upload CSV and disburse batch contractor payouts on Stellar",
        icon: Upload,
        action: () => {
          onClose();
          onDisbursePayroll();
        },
        keywords: ["payroll", "upload", "csv", "disburse", "batch", "contractor", "salary"],
      },
      {
        id: "action-copy-settlement",
        label: "Copy Settlement Address",
        category: "Actions",
        description: `Copy merchant treasury address (${shortAddress})`,
        icon: Copy,
        action: () => {
          onClose();
          onCopySettlementAddress();
        },
        keywords: ["wallet", "settlement", "vault", "copy", "address", "treasury", "stellar"],
      },

      // Navigation
      {
        id: "nav-overview",
        label: "Overview",
        category: "Navigation",
        description: "Dashboard metrics, monthly recurring volume, recent transactions",
        icon: LayoutDashboard,
        action: () => {
          onClose();
          onNavigateTab("overview");
        },
        keywords: ["home", "dashboard", "overview", "analytics", "stats", "metrics"],
      },
      {
        id: "nav-plans",
        label: "Plans",
        category: "Navigation",
        description: "Manage subscription plans, pricing tiers, and checkout links",
        icon: Package,
        action: () => {
          onClose();
          onNavigateTab("plans");
        },
        keywords: ["plans", "pricing", "tiers", "subscriptions", "usdc"],
      },
      {
        id: "nav-subscribers",
        label: "Subscribers",
        category: "Navigation",
        description: "Active subscribers, customer billing cycles, and recurring pulls",
        icon: Users,
        action: () => {
          onClose();
          onNavigateTab("subscribers");
        },
        keywords: ["subscribers", "customers", "members", "users", "wallets"],
      },
      {
        id: "nav-payroll",
        label: "Payroll",
        category: "Navigation",
        description: "Batch payouts, multisig approvals, and automated contractor disbursements",
        icon: SendHorizontal,
        action: () => {
          onClose();
          onNavigateTab("payroll");
        },
        keywords: ["payroll", "disburse", "team", "contractors", "batch"],
      },
      {
        id: "nav-developers",
        label: "Developers",
        category: "Navigation",
        description: "API keys, Webhook endpoints, GraphQL explorer, SDK docs",
        icon: Code2,
        action: () => {
          onClose();
          onNavigateTab("developers");
        },
        keywords: ["developers", "api", "keys", "webhooks", "graphql", "sdk", "docs"],
      },
      {
        id: "nav-multisig",
        label: "Multisig War Room",
        category: "Navigation",
        description: "Co-signers, signing sessions, and threshold execution",
        icon: UsersRound,
        action: () => {
          onClose();
          onNavigateTab("multisig");
        },
        keywords: ["multisig", "signatures", "war room", "security"],
      },
      {
        id: "nav-passes",
        label: "Gift Passes",
        category: "Navigation",
        description: "Pre-paid voucher links and promotional gift codes",
        icon: Gift,
        action: () => {
          onClose();
          onNavigateTab("passes");
        },
        keywords: ["passes", "gift", "coupons", "vouchers", "promotions"],
      },
      {
        id: "nav-domains",
        label: "Custom Domains",
        category: "Navigation",
        description: "Branded paywall subdomains and DNS verification",
        icon: Globe,
        action: () => {
          onClose();
          onNavigateTab("domains");
        },
        keywords: ["domains", "cname", "dns", "brand", "url"],
      },
      {
        id: "nav-links",
        label: "Payment Links",
        category: "Navigation",
        description: "Shareable hosted checkout URLs for customer onboarding",
        icon: Link2,
        action: () => {
          onClose();
          onNavigateTab("links");
        },
        keywords: ["links", "checkout", "share", "paywall"],
      },
      {
        id: "nav-team",
        label: "Team & Roles",
        category: "Navigation",
        description: "Manage organization members, permission tiers, and invited operators",
        icon: UserCog,
        action: () => {
          onClose();
          onNavigateTab("team");
        },
        keywords: ["team", "roles", "members", "permissions", "invites"],
      },

      // Existing Plans
      {
        id: "plan-mailkit-pro",
        label: "MailKit Pro",
        category: "Plans",
        description: "29.00 USDC / 30 days • 86 active subscribers",
        icon: CreditCard,
        action: () => {
          onClose();
          onNavigateTab("plans");
        },
        keywords: ["mailkit", "pro", "29", "usdc", "plan"],
      },
      {
        id: "plan-ai-starter",
        label: "AI Engine Starter",
        category: "Plans",
        description: "15.00 USDC / 30 days • 48 active subscribers",
        icon: CreditCard,
        action: () => {
          onClose();
          onNavigateTab("plans");
        },
        keywords: ["ai", "engine", "starter", "15", "usdc", "plan"],
      },
      {
        id: "plan-dao-retainer",
        label: "DAO Builder Pass",
        category: "Plans",
        description: "100.00 USDC / 30 days • 14 active subscribers",
        icon: CreditCard,
        action: () => {
          onClose();
          onNavigateTab("plans");
        },
        keywords: ["dao", "builder", "pass", "100", "usdc", "plan"],
      },

      // Active Subscribers
      {
        id: "sub-bob-9421",
        label: "GBOBZ...8K2",
        category: "Subscribers",
        description: "MailKit Pro • Active subscriber • Next pull: Due Now",
        icon: Wallet,
        action: () => {
          onClose();
          onNavigateTab("subscribers");
        },
        keywords: ["bob", "gbobz7m5w8y2k6t1r9p0v4n8d2l7c3f9a1h5j8k2", "subscriber"],
      },
      {
        id: "sub-alice-4812",
        label: "GALI3...9Q0",
        category: "Subscribers",
        description: "AI Engine Starter • Active subscriber • Next pull: In 12 days",
        icon: Wallet,
        action: () => {
          onClose();
          onNavigateTab("subscribers");
        },
        keywords: ["alice", "gali37h9p4b2n8c1x6k5m7w9d0f3l8t2v4j7r9q0", "subscriber"],
      },
      {
        id: "sub-charlie-9912",
        label: "GCHAR...X4B",
        category: "Subscribers",
        description: "DAO Builder Pass • Active subscriber • Next pull: In 28 days",
        icon: Wallet,
        action: () => {
          onClose();
          onNavigateTab("subscribers");
        },
        keywords: ["charlie", "gcharlie9912x4b", "subscriber"],
      },
    ];
  }, [user, onClose, onOpenCreatePlan, onDisbursePayroll, onCopySettlementAddress, onNavigateTab]);

  // Filter commands by search query
  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allCommands;
    return allCommands.filter((item) => {
      if (item.label.toLowerCase().includes(q)) return true;
      if (item.description?.toLowerCase().includes(q)) return true;
      if (item.category.toLowerCase().includes(q)) return true;
      if (item.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [allCommands, query]);

  // Adjust selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    if (listRef.current) {
      const activeEl = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      if (activeEl) {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  // Keyboard navigation inside command palette
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredCommands.length === 0 ? 0 : (prev + 1) % filteredCommands.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredCommands.length === 0 ? 0 : (prev - 1 + filteredCommands.length) % filteredCommands.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        filteredCommands[selectedIndex].action();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  // Group filtered commands by category
  const categories: Array<CommandItem["category"]> = ["Actions", "Navigation", "Plans", "Subscribers"];
  let globalItemIndex = -1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-xl rounded-2xl bg-white border border-black/10 shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150"
        onKeyDown={handleKeyDown}
      >
        {/* Search Bar Input */}
        <div className="flex items-center px-4 py-3.5 border-b border-black/10 gap-3 bg-neutral-50/50">
          <Search size={18} className="text-neutral-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search plans, subscribers, views... (Esc to exit)"
            className="flex-1 bg-transparent text-sm text-black placeholder:text-neutral-400 focus:outline-hidden font-sans"
            aria-autocomplete="list"
            aria-controls="command-palette-results"
            aria-activedescendant={filteredCommands[selectedIndex]?.id}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="p-1 rounded text-neutral-400 hover:text-black hover:bg-neutral-100"
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
          <kbd className="hidden sm:inline-flex items-center gap-0.5 px-2 py-0.5 text-[10px] font-mono font-semibold text-neutral-500 bg-neutral-100 border border-black/10 rounded">
            ESC
          </kbd>
        </div>

        {/* Results List */}
        <div
          ref={listRef}
          id="command-palette-results"
          role="listbox"
          className="max-h-80 overflow-y-auto p-2 divide-y divide-black/5"
        >
          {filteredCommands.length === 0 ? (
            <div className="py-12 text-center text-neutral-500 text-xs">
              <Command size={28} className="mx-auto mb-2 text-neutral-300" />
              <p className="font-medium">No results found for &ldquo;{query}&rdquo;</p>
              <p className="text-[11px] text-neutral-400 mt-1">Try searching for plans, subscribers, or navigation shortcuts.</p>
            </div>
          ) : (
            categories.map((category) => {
              const itemsInCategory = filteredCommands.filter((c) => c.category === category);
              if (itemsInCategory.length === 0) return null;

              return (
                <div key={category} className="py-1.5 first:pt-0 last:pb-0">
                  <div className="px-3 py-1 text-[10px] font-bold text-neutral-400 uppercase tracking-wider">
                    {category}
                  </div>
                  <div className="space-y-0.5">
                    {itemsInCategory.map((item) => {
                      globalItemIndex += 1;
                      const isSelected = globalItemIndex === selectedIndex;
                      const currentIndex = globalItemIndex;
                      const Icon = item.icon;

                      return (
                        <div
                          key={item.id}
                          id={item.id}
                          role="option"
                          aria-selected={isSelected}
                          data-index={currentIndex}
                          onClick={() => item.action()}
                          onMouseEnter={() => setSelectedIndex(currentIndex)}
                          className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs cursor-pointer transition-colors ${
                            isSelected
                              ? "bg-black text-white shadow-xs"
                              : "text-neutral-700 hover:bg-neutral-100/70"
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div
                              className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                                isSelected ? "bg-white/10 text-white" : "bg-neutral-100 text-black"
                              }`}
                            >
                              <Icon size={14} />
                            </div>
                            <div className="min-w-0">
                              <p className={`font-semibold truncate ${isSelected ? "text-white" : "text-black"}`}>
                                {item.label}
                              </p>
                              {item.description && (
                                <p className={`truncate text-[11px] ${isSelected ? "text-neutral-300" : "text-neutral-500"}`}>
                                  {item.description}
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0 pl-2">
                            {isSelected && (
                              <span className="text-[10px] font-mono font-medium text-neutral-300 flex items-center gap-1">
                                Jump <ArrowRight size={10} />
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer shortcuts helper */}
        <div className="px-4 py-2 border-t border-black/10 bg-neutral-50/70 flex items-center justify-between text-[11px] text-neutral-500">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded bg-white border border-black/10 text-[10px] font-mono">↑</kbd>
              <kbd className="px-1.5 py-0.5 rounded bg-white border border-black/10 text-[10px] font-mono">↓</kbd>
              <span>to navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded bg-white border border-black/10 text-[10px] font-mono">↵</kbd>
              <span>to select</span>
            </span>
          </div>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-white border border-black/10 text-[10px] font-mono">ESC</kbd>
            <span>to close</span>
          </span>
        </div>
      </div>
    </div>
  );
}
