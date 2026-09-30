/* === SMART BUTTON GROUP ROW DETECTION === */
function updateButtonGroupRadii() {
    document.querySelectorAll('.button-group').forEach(group => {
        const buttons = Array.from(group.querySelectorAll('.group-btn'));
        if (!buttons.length) return;

        // Clear previous classes
        buttons.forEach(btn => {
            btn.classList.remove('first-in-row', 'last-in-row', 'only-in-row');
        });

        // Group buttons by visual row (same offsetTop)
        let rows = [];
        let currentRow = [buttons[0]];
        let currentTop = buttons[0].offsetTop;

        for (let i = 1; i < buttons.length; i++) {
            const btn = buttons[i];
            if (Math.abs(btn.offsetTop - currentTop) < 4) {
                // Same row (4px tolerance for sub-pixel differences)
                currentRow.push(btn);
            } else {
                rows.push(currentRow);
                currentRow = [btn];
                currentTop = btn.offsetTop;
            }
        }
        rows.push(currentRow);

        // Apply row-aware classes
        rows.forEach(row => {
            if (row.length === 1) {
                row[0].classList.add('only-in-row');
            } else {
                row[0].classList.add('first-in-row');
                row[row.length - 1].classList.add('last-in-row');
            }
        });
    });
}

/* === STORAGE === */
// localStorage throws when site data is blocked; the toggle should still work
// for the current visit instead of breaking the whole script.
const storage = {
    get(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
        try { localStorage.setItem(key, value); } catch { }
    }
};

/* === THEME TOGGLE === */
function setupThemeToggle() {
    const KEY = 'theme-preference';
    const button = document.getElementById('theme-toggle');
    if (!button) return;

    const icons = { auto: 'fa-solid fa-circle-half-stroke', light: 'fa-regular fa-sun', dark: 'fa-regular fa-moon' };
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
    const stored = storage.get(KEY);
    let currentPref = Object.hasOwn(icons, stored) ? stored : 'auto';

    // The Font Awesome kit swaps each <i> for an <svg> and doesn't re-render when
    // the class changes, so replace the icon and let the kit convert the new one.
    const swapIcon = (newClasses) => {
        const i = document.createElement('i');
        i.className = newClasses;
        i.setAttribute('aria-hidden', 'true');
        button.replaceChildren(i);
    };

    const applyTheme = (theme) => {
        currentPref = theme;
        document.documentElement.setAttribute('data-theme', theme);
        storage.set(KEY, theme);
        swapIcon(icons[theme]);
        const label = theme.charAt(0).toUpperCase() + theme.slice(1);
        button.setAttribute('aria-label', `Theme: ${label}`);
        button.title = `Theme: ${label}`;
        // Update meta theme-color for browser chrome
        const isDark = theme === 'dark' || (theme === 'auto' && systemDark.matches);
        document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
        const meta = document.createElement('meta');
        meta.name = 'theme-color';
        meta.content = isDark ? '#0c0e14' : '#ffffff';
        document.head.appendChild(meta);
    };

    button.addEventListener('click', () => {
        let newPref;

        if (systemDark.matches) {
            if (currentPref === 'auto' || currentPref === 'dark') {
                newPref = 'light';
            } else {
                newPref = 'auto';
            }
        } else {
            if (currentPref === 'auto' || currentPref === 'light') {
                newPref = 'dark';
            } else {
                newPref = 'auto';
            }
        }
        applyTheme(newPref);
    });

    systemDark.addEventListener('change', () => {
        if (currentPref === 'auto') {
            applyTheme('auto');
        }
    });

    applyTheme(currentPref);
}

/* === CAT COMPANION === */
const catMessages = [
    "Psst. I helped build this site... mostly by sitting on the keyboard.",
    "I've knocked all the pens off the desk. My work here is done.",
    "I'm not sleeping, I'm compiling. It's a very complex process.",
    "The box this computer came in was far more interesting than the computer itself.",
    "Oh, were you using this piece of paper? It looked like it desperately needed to be on the floor.",
    "I've conducted extensive stress tests on that chair you're sitting in. It's... adequate.",
    "Some call it mischief, I call it 'unsolicited quality assurance testing'.",
    "That houseplant looked at me funny. It had to go.",
    "My human thinks they're in charge. It's quite adorable, isn't it?",
    "Just so we're clear, this is my flat. I just let the human pay the rent.",
    "I have a doctorate in Napping from the University of Sunbeams. What's your excuse?",
    "My schedule today: 10:00 nap, 11:00 pre-lunch nap, 12:00 lunch, 14:00 post-lunch nap...",
    "I'm not ignoring you, I'm simply in energy-saving mode.",
    "Of course, I understand thermodynamics. A lap is warm (ΔQ > 0), the floor is not.",
    "The human went to university; I mastered structural engineering by finding the single weakest point of a cardboard box.",
    "My food bowl is only 98% full. I consider this a catastrophic failure of service.",
    "I see you have a biscuit. I also like biscuits. We should have a chat. 🧐",
    "A sunbeam has appeared 2 metres to my left. I must relocate immediately. This is not a drill.",
    "The sound of a snack packet rustling from another room? I can get there in 2.7 seconds. Olympic-level.",
    "It is precisely 19:03. Are you aware of the critically low biscuit levels?",
    "I'm powered by a complex algorithm of treats and head scratches.",
    "Welcome! Don't mind me, I'm just supervising the human.",
    "If you scroll too fast, I'm going to try and catch your mouse cursor.",
    "Go on, try to click me again. I dare you.",
    "Are you still here? Impressive focus for a human.",
    "Don't tell anyone, but I'm the real reason this website is so purr-fect.",
    "I've reviewed your user session. My analysis indicates a severe lack of attention being paid to me.",
    "I've sent a few emails on your behalf. They mostly say 'sdfghjkl;'. You're welcome.",
    "Alright? Just having a little rest before my next big rest.",
    "Blimey, that's a lot of reading. My eyes are tired just looking at it.",
    "Was that a bird? Sorry, I lost my train of thought. What were we talking about?",
    "They say curiosity killed the cat, but satisfaction brought it back. That's why I get nine lives. 😉",
    "The human's typing is so loud. It's putting me off my afternoon slumber.",
    "Right, that's enough screen time for one day. Where's the telly remote?",
    "Kalofsh një ditë të bukur!"
];

function setupCatCompanion() {
    const cat = document.getElementById('cat-companion');
    const bubble = document.getElementById('cat-speech-bubble');
    if (!cat || !bubble) return;

    cat.setAttribute('role', 'button');
    cat.setAttribute('tabindex', '0');
    cat.setAttribute('aria-label', 'Cat Companion: Click for a message');

    let bubbleTimeout;
    let animationTimeout;
    let lastIndex = -1; // Track the last message to avoid repeats

    const triggerCatInteraction = () => {
        const chance = 10000;
        const randomNumber = Math.floor(Math.random() * chance);

        if (randomNumber === 0) {
            window.open('https://youtu.be/dQw4w9WgXcQ', '_blank', 'noopener');
            return;
        }

        let randomIndex;
        do {
            randomIndex = Math.floor(Math.random() * catMessages.length);
        } while (randomIndex === lastIndex && catMessages.length > 1);
        lastIndex = randomIndex;

        if (bubble.classList.contains('visible')) {
            // Already open: swap text immediately and reset the auto-hide timer.
            bubble.textContent = catMessages[randomIndex];
            clearTimeout(bubbleTimeout);

            bubbleTimeout = setTimeout(() => {
                bubble.classList.remove('visible');
            }, 6000);
        } else {
            clearTimeout(animationTimeout);

            animationTimeout = setTimeout(() => {
                bubble.textContent = catMessages[randomIndex];
                bubble.classList.add('visible');
            }, 50);

            bubbleTimeout = setTimeout(() => {
                bubble.classList.remove('visible');
            }, 6000);
        }
    };

    cat.addEventListener('click', (event) => {
        event.stopPropagation();
        triggerCatInteraction();
    });

    cat.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            triggerCatInteraction();
        }
    });

    document.addEventListener('click', (event) => {
        if (bubble.classList.contains('visible') && !cat.contains(event.target)) {
            bubble.classList.remove('visible');
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') bubble.classList.remove('visible');
    });
}

/* === COPYRIGHT YEARS === */
// Shows "2026" in the first year and "2026–<this year>" after that.
function updateYear() {
    const el = document.getElementById('copyright-years');
    if (!el) return;
    const start = Number(el.dataset.start);
    const year = new Date().getFullYear();
    el.textContent = year > start ? `${start}–${year}` : String(start);
}

/* === INIT === */
document.addEventListener('DOMContentLoaded', function () {
    updateYear();
    setupThemeToggle();
    setupCatCompanion();

    // Re-check whenever a group changes size: window resizes, but also late web
    // font and icon loads, which can change how the buttons wrap.
    const groupObserver = new ResizeObserver(updateButtonGroupRadii);
    document.querySelectorAll('.button-group').forEach(group => groupObserver.observe(group));

    // The cat is hidden until this class is added, so it slides in once the page is ready.
    const cat = document.getElementById('cat-companion');
    if (cat) cat.classList.add('visible');
});
