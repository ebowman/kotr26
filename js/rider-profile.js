/**
 * KOTR 2026 - Rider Profile Module
 * Manages rider weight and FTP settings with localStorage persistence
 */

const RiderProfile = (function() {
    'use strict';

    // Storage key
    const STORAGE_KEY = 'kotr-rider-profile';

    // Default values
    const DEFAULTS = {
        weight: 75,  // kg
        ftp: 200,    // watts
        isConfigured: false
    };

    // Constraints
    const CONSTRAINTS = {
        weight: { min: 40, max: 150, step: 1 },
        ftp: { min: 50, max: 500, step: 5 }
    };

    // Current profile state
    let profile = { ...DEFAULTS };

    // Callbacks for profile changes
    let onProfileChange = null;

    /**
     * Load profile from localStorage
     */
    function load() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                profile = {
                    weight: clampWeight(parsed.weight ?? DEFAULTS.weight),
                    ftp: clampFTP(parsed.ftp ?? DEFAULTS.ftp),
                    isConfigured: parsed.isConfigured ?? false
                };
            }
        } catch (e) {
            console.warn('Failed to load rider profile:', e);
            profile = { ...DEFAULTS };
        }
        return profile;
    }

    /**
     * Save profile to localStorage
     */
    function save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
        } catch (e) {
            console.warn('Failed to save rider profile:', e);
        }
    }

    /**
     * Update profile values
     */
    function update(values) {
        if (values.weight !== undefined) {
            profile.weight = clampWeight(values.weight);
        }
        if (values.ftp !== undefined) {
            profile.ftp = clampFTP(values.ftp);
        }
        profile.isConfigured = true;
        save();

        // Notify listeners
        if (onProfileChange) {
            onProfileChange(profile);
        }

        return profile;
    }

    /**
     * Clear/reset profile
     */
    function clear() {
        profile = { ...DEFAULTS };
        save();
        if (onProfileChange) {
            onProfileChange(profile);
        }
        return profile;
    }

    /**
     * Get current profile
     */
    function get() {
        return { ...profile };
    }

    /**
     * Check if profile is configured
     */
    function isConfigured() {
        return profile.isConfigured;
    }

    /**
     * Get W/kg (watts per kilogram)
     */
    function getWPerKg() {
        return profile.ftp / profile.weight;
    }

    /**
     * Clamp weight to valid range
     */
    function clampWeight(value) {
        const num = parseFloat(value);
        if (isNaN(num)) return DEFAULTS.weight;
        return Math.max(CONSTRAINTS.weight.min, Math.min(CONSTRAINTS.weight.max, num));
    }

    /**
     * Clamp FTP to valid range
     */
    function clampFTP(value) {
        const num = parseFloat(value);
        if (isNaN(num)) return DEFAULTS.ftp;
        return Math.max(CONSTRAINTS.ftp.min, Math.min(CONSTRAINTS.ftp.max, num));
    }

    /**
     * Set callback for profile changes
     */
    function setOnChange(callback) {
        onProfileChange = callback;
    }

    /**
     * Create and show the settings modal
     */
    function showModal() {
        // Remove existing modal if present
        const existing = document.getElementById('rider-profile-modal');
        if (existing) {
            existing.remove();
        }

        const currentProfile = get();

        const modal = document.createElement('div');
        modal.id = 'rider-profile-modal';
        modal.className = 'rider-profile-modal';
        modal.innerHTML = `
            <div class="rider-profile-overlay" data-close-modal></div>
            <div class="rider-profile-content">
                <div class="rider-profile-header">
                    <h2>Rider Profile</h2>
                    <button class="rider-profile-close" data-close-modal aria-label="Close">&times;</button>
                </div>

                <p class="rider-profile-intro">Enter your details for personalized route analysis including power estimates, difficulty ratings, and energy expenditure.</p>

                <div class="rider-profile-form">
                    <div class="rider-profile-field">
                        <label for="rider-weight">
                            <span class="field-label">Weight</span>
                            <span class="field-value"><span id="weight-display">${currentProfile.weight}</span> kg</span>
                        </label>
                        <input type="range"
                               id="rider-weight"
                               min="${CONSTRAINTS.weight.min}"
                               max="${CONSTRAINTS.weight.max}"
                               step="${CONSTRAINTS.weight.step}"
                               value="${currentProfile.weight}">
                        <div class="range-labels">
                            <span>${CONSTRAINTS.weight.min} kg</span>
                            <span>${CONSTRAINTS.weight.max} kg</span>
                        </div>
                    </div>

                    <div class="rider-profile-field">
                        <label for="rider-ftp">
                            <span class="field-label">FTP</span>
                            <span class="field-value"><span id="ftp-display">${currentProfile.ftp}</span> W</span>
                        </label>
                        <input type="range"
                               id="rider-ftp"
                               min="${CONSTRAINTS.ftp.min}"
                               max="${CONSTRAINTS.ftp.max}"
                               step="${CONSTRAINTS.ftp.step}"
                               value="${currentProfile.ftp}">
                        <div class="range-labels">
                            <span>${CONSTRAINTS.ftp.min} W</span>
                            <span>${CONSTRAINTS.ftp.max} W</span>
                        </div>
                        <div class="ftp-help">
                            <button type="button" class="ftp-help-toggle" aria-expanded="false">
                                What's FTP? <span class="help-icon">?</span>
                            </button>
                            <div class="ftp-help-content" hidden>
                                <p><strong>Functional Threshold Power (FTP)</strong> is the maximum power (in watts) you can sustain for approximately one hour.</p>
                                <p>If you don't know your FTP:</p>
                                <ul>
                                    <li>Beginner: 100-150W</li>
                                    <li>Recreational: 150-200W</li>
                                    <li>Fit cyclist: 200-280W</li>
                                    <li>Competitive: 280-350W</li>
                                    <li>Elite: 350W+</li>
                                </ul>
                            </div>
                        </div>
                    </div>

                    <div class="rider-profile-summary">
                        <div class="summary-stat">
                            <span class="summary-label">W/kg</span>
                            <span class="summary-value" id="wkg-display">${(currentProfile.ftp / currentProfile.weight).toFixed(2)}</span>
                        </div>
                        <div class="summary-rating" id="wkg-rating">${getWkgRating(currentProfile.ftp / currentProfile.weight)}</div>
                    </div>
                </div>

                <div class="rider-profile-actions">
                    <button type="button" class="btn btn-secondary" data-close-modal>Cancel</button>
                    <button type="button" class="btn btn-primary" id="save-profile">Save Profile</button>
                </div>

                ${currentProfile.isConfigured ? `
                <div class="rider-profile-reset">
                    <button type="button" class="btn-reset" id="reset-profile">Clear Profile</button>
                </div>
                ` : ''}

                <div class="rider-profile-privacy">
                    <span class="privacy-icon">🔒</span>
                    <span class="privacy-text">Your data never leaves your browser. All settings are stored locally on your device.</span>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Setup event listeners
        const weightSlider = document.getElementById('rider-weight');
        const ftpSlider = document.getElementById('rider-ftp');
        const weightDisplay = document.getElementById('weight-display');
        const ftpDisplay = document.getElementById('ftp-display');
        const wkgDisplay = document.getElementById('wkg-display');
        const wkgRating = document.getElementById('wkg-rating');

        function updateDisplays() {
            const weight = parseFloat(weightSlider.value);
            const ftp = parseFloat(ftpSlider.value);
            const wkg = ftp / weight;

            weightDisplay.textContent = weight;
            ftpDisplay.textContent = ftp;
            wkgDisplay.textContent = wkg.toFixed(2);
            wkgRating.textContent = getWkgRating(wkg);
        }

        weightSlider.addEventListener('input', updateDisplays);
        ftpSlider.addEventListener('input', updateDisplays);

        // FTP help toggle
        const ftpHelpToggle = modal.querySelector('.ftp-help-toggle');
        const ftpHelpContent = modal.querySelector('.ftp-help-content');
        ftpHelpToggle.addEventListener('click', () => {
            const expanded = ftpHelpToggle.getAttribute('aria-expanded') === 'true';
            ftpHelpToggle.setAttribute('aria-expanded', !expanded);
            ftpHelpContent.hidden = expanded;
        });

        // Close handlers
        modal.querySelectorAll('[data-close-modal]').forEach(el => {
            el.addEventListener('click', hideModal);
        });

        // Save handler
        document.getElementById('save-profile').addEventListener('click', () => {
            update({
                weight: parseFloat(weightSlider.value),
                ftp: parseFloat(ftpSlider.value)
            });
            hideModal();
            updateSettingsIndicator();
        });

        // Reset handler
        const resetBtn = document.getElementById('reset-profile');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                clear();
                hideModal();
                updateSettingsIndicator();
            });
        }

        // Close on escape
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                hideModal();
            }
        };
        document.addEventListener('keydown', escHandler);
        modal._escHandler = escHandler;

        // Animate in
        requestAnimationFrame(() => {
            modal.classList.add('visible');
        });
    }

    /**
     * Hide the settings modal
     */
    function hideModal() {
        const modal = document.getElementById('rider-profile-modal');
        if (modal) {
            if (modal._escHandler) {
                document.removeEventListener('keydown', modal._escHandler);
            }
            modal.classList.remove('visible');
            setTimeout(() => modal.remove(), 300);
        }
    }

    /**
     * Get W/kg category rating
     */
    function getWkgRating(wkg) {
        if (wkg < 1.5) return 'Beginner';
        if (wkg < 2.5) return 'Recreational';
        if (wkg < 3.5) return 'Fit';
        if (wkg < 4.5) return 'Competitive';
        if (wkg < 5.5) return 'Elite';
        return 'Pro';
    }

    /**
     * Update the settings indicator in the header
     */
    function updateSettingsIndicator() {
        const indicator = document.getElementById('profile-status');
        if (indicator) {
            if (isConfigured()) {
                indicator.classList.add('configured');
                indicator.title = `${profile.weight}kg, ${profile.ftp}W FTP (${getWPerKg().toFixed(1)} W/kg)`;
            } else {
                indicator.classList.remove('configured');
                indicator.title = 'Set up your rider profile';
            }
        }
    }

    /**
     * Initialize - attach click handler to settings button
     */
    function init() {
        load();

        // Attach click handler to existing settings button in trip summary bar
        const settingsBtn = document.getElementById('rider-settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', showModal);
        }

        updateSettingsIndicator();
    }

    // Public API
    return {
        init,
        load,
        save,
        update,
        clear,
        get,
        isConfigured,
        getWPerKg,
        showModal,
        hideModal,
        setOnChange,
        CONSTRAINTS,
        DEFAULTS
    };
})();

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RiderProfile;
}
