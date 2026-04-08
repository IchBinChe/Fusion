import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Terminal, Play, Settings, Loader2, ChevronDown } from "lucide-react";
import { fetchScripts } from "../api";

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
}

export interface QuickScriptsDropdownProps {
  onOpenScripts: () => void;
  onRunScript: (name: string, command: string) => void;
  projectId?: string;
}

/**
 * QuickScriptsDropdown - Dropdown for quick script execution
 *
 * Features:
 * - Dropdown trigger with Terminal icon + chevron
 * - Fetches and displays all available scripts
 * - Click to run script immediately (opens terminal)
 * - "Manage Scripts..." footer to open full modal
 * - Keyboard navigation: arrow keys, enter to run, escape to close
 * - Loading state while fetching
 * - Empty state when no scripts configured
 * - Closes on outside click
 */
export function QuickScriptsDropdown({
  onOpenScripts,
  onRunScript,
  projectId,
}: QuickScriptsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const getEffectiveViewport = useCallback(() => {
    const vv = window.visualViewport;
    if (vv && vv.width > 0 && vv.height > 0) {
      return {
        width: vv.width,
        height: vv.height,
        offsetTop: vv.offsetTop,
        offsetLeft: vv.offsetLeft,
      };
    }

    return {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetTop: 0,
      offsetLeft: 0,
    };
  }, []);

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const menu = menuRef.current;
    const { width: viewportWidth, height: viewportHeight, offsetTop, offsetLeft } = getEffectiveViewport();
    const horizontalPadding = 16;
    const verticalPadding = 16;
    const gap = 6;

    const measuredWidth = menu?.offsetWidth || Math.max(rect.width, 260);
    const width = Math.min(
      measuredWidth,
      Math.max(viewportWidth - horizontalPadding * 2, 160),
    );

    const measuredHeight = menu?.offsetHeight || 280;
    const constrainedHeight = Math.min(
      measuredHeight,
      Math.max(viewportHeight - verticalPadding * 2, 160),
    );

    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerLeft = rect.left - offsetLeft;

    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;

    const openUpward = spaceBelow < constrainedHeight && spaceAbove > spaceBelow;

    const left = Math.min(
      Math.max(triggerLeft, horizontalPadding),
      viewportWidth - horizontalPadding - width,
    ) + offsetLeft;

    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - constrainedHeight - gap + offsetTop)
      : Math.min(
          triggerBottom + gap + offsetTop,
          viewportHeight + offsetTop - verticalPadding - constrainedHeight,
        );

    setDropdownPosition({ top, left, width });
  }, [getEffectiveViewport]);

  // Script entries sorted alphabetically
  const scriptEntries = useMemo(() => {
    return Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b));
  }, [scripts]);

  const showFooter = scriptEntries.length > 0;

  // Total items for keyboard navigation (scripts + "Manage Scripts...")
  const totalItems = scriptEntries.length + (showFooter ? 1 : 0);

  // Fetch scripts when dropdown opens
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setLoading(true);

    fetchScripts(projectId)
      .then((data) => {
        if (!cancelled) {
          setScripts(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScripts({});
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Reset highlight when dropdown opens and focus the menu
  useEffect(() => {
    if (isOpen) {
      setHighlightedIndex(-1);
      // Focus menu for keyboard navigation
      const timeoutId = window.setTimeout(() => menuRef.current?.focus(), 0);
      return () => window.clearTimeout(timeoutId);
    }

    setDropdownPosition(null);
  }, [isOpen]);

  // Position dropdown when opening and whenever content size changes.
  useEffect(() => {
    if (!isOpen) return;

    const rafId = requestAnimationFrame(() => {
      updateDropdownPosition();
    });

    return () => cancelAnimationFrame(rafId);
  }, [isOpen, loading, scriptEntries.length, showFooter, updateDropdownPosition]);

  // Keep dropdown anchored on viewport and container changes.
  useEffect(() => {
    if (!isOpen) return;

    const handleReposition = () => updateDropdownPosition();

    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", handleReposition);
      vv.addEventListener("scroll", handleReposition);
    }

    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      if (vv) {
        vv.removeEventListener("resize", handleReposition);
        vv.removeEventListener("scroll", handleReposition);
      }
    };
  }, [isOpen, updateDropdownPosition]);

  // Handle keyboard navigation within dropdown
  const handleDropdownKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < totalItems - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev > 0 ? prev - 1 : totalItems - 1
          );
          break;
        case "Enter":
          e.preventDefault();
          if (highlightedIndex >= 0) {
            if (highlightedIndex < scriptEntries.length) {
              // Run script
              const [name, command] = scriptEntries[highlightedIndex];
              handleRunScript(name, command);
            } else if (showFooter && highlightedIndex === scriptEntries.length) {
              // Manage Scripts...
              handleManageScripts();
            }
          }
          break;
        case "Home":
          e.preventDefault();
          setHighlightedIndex(0);
          break;
        case "End":
          e.preventDefault();
          setHighlightedIndex(totalItems - 1);
          break;
      }
    },
    [highlightedIndex, totalItems, scriptEntries, showFooter]
  );

  // Toggle dropdown
  const toggleDropdown = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  // Handle run script
  const handleRunScript = useCallback(
    (name: string, command: string) => {
      onRunScript(name, command);
      setIsOpen(false);
    },
    [onRunScript]
  );

  // Handle manage scripts
  const handleManageScripts = useCallback(() => {
    onOpenScripts();
    setIsOpen(false);
  }, [onOpenScripts]);

  return (
    <div className="quick-scripts-dropdown" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        className={`btn-icon quick-scripts-dropdown__trigger ${isOpen ? "open btn-icon--active" : ""}`}
        onClick={toggleDropdown}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Quick scripts"
        data-testid="scripts-btn"
        title="Scripts"
      >
        <Terminal size={16} />
        <ChevronDown
          size={14}
          className={`quick-scripts-dropdown__trigger-chevron ${isOpen ? "rotate" : ""}`}
        />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          ref={menuRef}
          tabIndex={-1}
          className="quick-scripts-dropdown__menu"
          role="listbox"
          aria-label="Scripts"
          onKeyDown={handleDropdownKeyDown}
          data-testid="quick-scripts-dropdown"
          style={
            dropdownPosition
              ? {
                  position: "fixed",
                  top: `${dropdownPosition.top}px`,
                  left: `${dropdownPosition.left}px`,
                  width: `${dropdownPosition.width}px`,
                  right: "auto",
                }
              : undefined
          }
        >
          {loading ? (
            <div className="quick-scripts-dropdown__loading" data-testid="quick-scripts-loading">
              <Loader2 size={16} className="animate-spin" />
              <span>Loading scripts...</span>
            </div>
          ) : scriptEntries.length === 0 ? (
            <div className="quick-scripts-dropdown__empty" data-testid="quick-scripts-empty">
              <div className="quick-scripts-dropdown__empty-icon">
                <Terminal size={16} />
              </div>
              <p>No scripts configured</p>
              <button
                className="quick-scripts-dropdown__empty-action btn"
                onClick={handleManageScripts}
              >
                Add your first script
              </button>
            </div>
          ) : (
            <>
              {/* Script list */}
              <div className="quick-scripts-dropdown__list">
                {scriptEntries.map(([name, command], index) => (
                  <button
                    key={name}
                    className={`quick-scripts-dropdown__item ${
                      highlightedIndex === index ? "highlighted" : ""
                    }`}
                    onClick={() => handleRunScript(name, command)}
                    role="option"
                    aria-selected={highlightedIndex === index}
                    data-testid={`quick-script-item-${name}`}
                  >
                    <Play size={14} className="quick-scripts-dropdown__item-icon" />
                    <div className="quick-scripts-dropdown__item-info">
                      <span className="quick-scripts-dropdown__item-name">{name}</span>
                      <span className="quick-scripts-dropdown__item-command" title={command}>
                        {command.length > 50 ? `${command.slice(0, 50)}...` : command}
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              {/* Footer */}
              <div className="quick-scripts-dropdown__footer">
                <button
                  className={`quick-scripts-dropdown__manage ${
                    showFooter && highlightedIndex === scriptEntries.length ? "highlighted" : ""
                  }`}
                  onClick={handleManageScripts}
                  data-testid="quick-scripts-manage"
                >
                  <Settings size={14} />
                  <span>Manage Scripts...</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
