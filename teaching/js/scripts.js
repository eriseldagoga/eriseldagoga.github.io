        // Configuration
        let isArchiveMode = false;

        // Global variables
        let availableCourses = [];
        let currentCourse = '';
        let courseMap = {};
        let pendingNotifications = [];
        let isInitializing = true;
        let criticalErrorsOnly = true;
        const courseData = { metadata: {}, modules: [] };
        const courseDataCache = {}; // Cache for fetched course data
        let isProgrammaticScroll = false;

        /* SWIPE DISABLED — start (globals) */
        // const swipeArea = document.body;
        // let touchstartX = 0, touchendX = 0, touchstartY = 0, touchendY = 0;
        // let isInsideIgnoredArea = false;
        /* SWIPE DISABLED — end (globals) */

        // Helper to get cache prefix based on mode
        function getCachePrefix() {
            return isArchiveMode ? 'archive_' : 'active_';
        }

        /**
         * Handles clicks on action buttons (View, Download, etc.)
         * Applies 'stuck' feedback, then opens the link after a short delay to allow rendering.
         * @param {HTMLElement} button - The button element that was clicked.
         * @param {string} url - The URL to open.
         */
        function applyClickFeedback(selector, duration = 1500) {
            // Use event delegation on the document for dynamically added buttons
            document.addEventListener('click', function (event) {
                const button = event.target.closest(selector);

                if (button) {
                    // Prevent re-triggering if already stuck
                    if (button.classList.contains('is-stuck')) return;

                    button.classList.add('is-stuck');
                    setTimeout(() => {
                        button.classList.remove('is-stuck');
                    }, duration);
                }
            });
        }

        function handleActionClick(button, url) {
            // 1. Immediately apply the "pushed in" style
            button.classList.add('is-stuck');

            // 2. Force the browser to render the style change NOW.
            //    Accessing the element's offsetHeight is a well-known trick 
            //    to trigger a browser reflow, ensuring the animation starts.
            void button.offsetHeight;

            // 3. With the animation now visibly running, open the new link.
            window.open(url, '_blank', 'noopener,noreferrer');

            // 4. Set a timer to remove the "stuck" class for when the user
            //    eventually returns to this tab.
            setTimeout(() => {
                button.classList.remove('is-stuck');
            }, 1500);
        }

        // --- Random Spinner GIF Logic ---
        const spinnerGifs = [
            '../miscellaneous/loading.webp',
            '../miscellaneous/loading_2.gif',
            '../miscellaneous/loading_3.gif',
            '../miscellaneous/loading_5.webp',
            '../miscellaneous/loading_6.webp'
        ];

        function setRandomSpinnerGif() {
            const spinnerImg = document.getElementById('spinner-image');
            if (!spinnerImg) return;

            let chosenGif = sessionStorage.getItem('spinnerGifUrl');

            if (!chosenGif) {
                const randomIndex = Math.floor(Math.random() * spinnerGifs.length);
                chosenGif = spinnerGifs[randomIndex];
                sessionStorage.setItem('spinnerGifUrl', chosenGif);
            }

            spinnerImg.onload = () => {
                spinnerImg.classList.add('loaded');
            };

            spinnerImg.src = chosenGif;
        }

        function setupMobileFab() {
            const fab = document.getElementById('mobile-fab');
            const overlay = document.getElementById('fab-overlay');
            const menu = document.getElementById('mobile-fab-menu');

            const mq = window.matchMedia('(max-width: 1400px)');
            const applyFabVisibility = () => {
                if (!fab) return;
                if (mq.matches) fab.classList.add('is-ready');
                else fab.classList.remove('is-ready');
            };
            mq.addEventListener?.('change', applyFabVisibility);
            applyFabVisibility();

            if (!fab || !overlay || !menu) return;

            const toggleMenu = () => {
                const isActive = fab.classList.contains('active');
                fab.classList.toggle('active');
                overlay.classList.toggle('active');
                menu.classList.toggle('active');

                // THIS IS THE FIX: Apply the 'no-scroll' class to BOTH the <html> and <body> tags.
                document.documentElement.classList.toggle('no-scroll');
                document.body.classList.toggle('no-scroll');

                /* SWIPE DISABLED — start (fab toggle) */
                // if (!isActive) {
                //     removeSwipeListeners();
                // } else {
                //     addSwipeListeners();
                // }
                /* SWIPE DISABLED — end (fab toggle) */
            };
            fab.addEventListener('click', toggleMenu);
            overlay.addEventListener('click', toggleMenu);
        }

        function init() {
            applyThemeDefaults();
            setRandomSpinnerGif();
            updateYear();
            applyOwnerBranding();
            // Opt-out kill switch: config.catCompanion === false removes the element,
            // after which every cat function no-ops on its null getElementById lookup.
            if (window.TEACHING_CONFIG && window.TEACHING_CONFIG.catCompanion === false) {
                const catEl = document.getElementById('cat-companion');
                if (catEl) catEl.remove();
            }
            initContainers();
            setupMobileFab();
            applyClickFeedback('#sort-button');
            setupThemeToggle();
            setupCatCompanion();
            checkUrlForCourse();
            loadModuleStates();
            setupSideNavToggle();
            applySideNavState();
            // setupCourseSwipe(); /* SWIPE DISABLED */

            // Check if URL indicates archive mode initially
            if (new URLSearchParams(window.location.search).has('archive')) {
                isArchiveMode = true;
            }

            // Initialize backend and load courses
            initBackend();

            // Initialize faders immediately so skeletons have the fade effect
            setTimeout(() => {
                initializeScrollFaders();
            }, 50);

            window.addEventListener('scroll', updateActiveNavLink);

            // Catch when the user manually changes the hash in the URL bar
            window.addEventListener('hashchange', () => {
                const hash = window.location.hash.substring(1);
                if (hash && hash !== 'module-' && availableCourses.length > 0) {
                    if (availableCourses.includes(hash)) {
                        selectCourse(hash);
                    } else {
                        // Trigger backend lookup if hash doesn't exist in current mode
                        tryPublicAccess();
                    }
                }
            });
        }

        function handleArchiveToggle(e) {
            e.preventDefault();

            // --- NEW: Freeze height and inject skeletons before state change ---
            const courseContent = document.getElementById('course-content');
            const courseButtons = document.getElementById('course-buttons-container');

            if (courseContent) {
                // On mobile the cat is perched INSIDE course-content; the innerHTML wipe
                // below would destroy that node outright (getElementById returns null from
                // then on and the cat never returns until reload — this is the "cat vanishes
                // when I switch to/from Archived" bug). Detach it to <body> first, dropping
                // cat-perched so it's cleanly hidden until positionCatCompanion() re-homes it.
                const perchedCat = document.getElementById('cat-companion');
                if (perchedCat && perchedCat.parentElement === courseContent) {
                    perchedCat.classList.remove('cat-perched');
                    document.body.appendChild(perchedCat);
                }

                // Lock the height to its current pixel dimension
                courseContent.style.minHeight = courseContent.offsetHeight + 'px';

                // Immediately inject the skeleton HTML structure
                courseContent.innerHTML = `
                    <div class="skeleton-search"></div>
                    <div class="skeleton-module">
                        <div class="skeleton-module-header"></div>
                        <div class="skeleton-material-cards">
                            <div class="skeleton skeleton-material-card"></div>
                            <div class="skeleton skeleton-material-card"></div>
                        </div>
                    </div>
                    <div class="skeleton-module">
                        <div class="skeleton-module-header"></div>
                        <div class="skeleton-material-cards">
                            <div class="skeleton skeleton-material-card"></div>
                        </div>
                    </div>
                `;
            }

            if (courseButtons) {
                courseButtons.style.minHeight = courseButtons.offsetHeight + 'px';
                courseButtons.innerHTML = `
                    <div class="skeleton-tabs-wrapper" style="display: flex; gap: 2px;">
                        <div class="skeleton skeleton-course-button"></div>
                        <div class="skeleton skeleton-course-button"></div>
                        <div class="skeleton skeleton-course-button"></div>
                        <div class="skeleton skeleton-course-button"></div>
                        <div class="skeleton skeleton-course-button"></div>
                        <div class="skeleton skeleton-course-button"></div>
                    </div>
                `;
            }
            // -------------------------------------------------------------------

            isArchiveMode = !isArchiveMode;

            // Update the URL visibly so users can share links to Archive states
            const url = new URL(window.location);
            if (isArchiveMode) {
                url.searchParams.set('archive', '');
            } else {
                url.searchParams.delete('archive');
            }

            // Clean up the trailing '=' if it gets added by searchParams.set('', '')
            let newUrlString = url.toString().replace(/archive=(&|$)/, 'archive$1');

            // Wipe the hash so the toggle resets cleanly to the last remembered course for that view
            url.hash = '';

            // Use pushState so this registers as a true page navigation to the browser
            window.history.pushState({ archive: isArchiveMode }, '', newUrlString || url);

            // Explicitly wipe the hash from the browser's visible URL so the upcoming fetch doesn't read it
            if (window.location.hash) {
                window.history.replaceState(null, '', window.location.pathname + window.location.search);
            }

            resetForModeSwitch();
        }

        // Catch the browser back/forward buttons to elegantly flip archive state
        window.addEventListener('popstate', (e) => {
            if (e.state && e.state.archive !== undefined) {
                if (isArchiveMode !== e.state.archive) {
                    isArchiveMode = e.state.archive;
                    resetForModeSwitch();
                }
            } else {
                // If there's no state object (e.g. back to initial load), check the URL again
                const urlParams = new URLSearchParams(window.location.search);
                const shouldBeArchive = urlParams.has('archive');
                if (isArchiveMode !== shouldBeArchive) {
                    isArchiveMode = shouldBeArchive;
                    resetForModeSwitch();
                }
            }
        });

        function resetForModeSwitch() {
            // Show loading state
            document.body.classList.add('is-loading');

            // Hard clear current data buffers so active and archive arrays do not mix and scramble CSS
            availableCourses = [];
            currentCourse = '';
            courseMap = {};

            // Aggressively flush all caching related to courses 
            for (let key in courseDataCache) {
                delete courseDataCache[key];
            }

            localStorage.removeItem('active_courseCodesCache');
            localStorage.removeItem('archive_courseCodesCache');

            document.getElementById('course-buttons-container').innerHTML = '';
            const contentEl = document.getElementById('course-content');
            const perchedCat = document.getElementById('cat-companion');
            if (perchedCat && perchedCat.parentElement === contentEl) {
                // Move it out of the doomed content AND drop cat-perched. During the async
                // reload gap the cat sits directly in <body>; an orphaned cat-perched there
                // leaves it as a 0-height element stranded at the page bottom on mobile
                // (reads as "the cat vanished when I switched to Archived"). Cleared here it's
                // cleanly hidden until positionCatCompanion() re-perches it on the new content.
                perchedCat.classList.remove('cat-perched');
                document.body.appendChild(perchedCat);
            }
            contentEl.innerHTML = '';

            // Re-initialize from new source
            initBackend();
        }

        function setupSideNavToggle() {
            const toggleBtn = document.getElementById('side-nav-toggle');
            const sideNav = document.getElementById('side-nav-container');

            if (!toggleBtn || !sideNav) return;

            toggleBtn.addEventListener('click', () => {
                sideNav.classList.toggle('collapsed');
                toggleBtn.classList.toggle('toggled'); // This line was missing

                const isCollapsed = sideNav.classList.contains('collapsed');
                localStorage.setItem('sideNavState', isCollapsed ? 'collapsed' : 'expanded');
            });
        }

        function applySideNavState() {
            const sideNav = document.getElementById('side-nav-container');
            const toggleBtn = document.getElementById('side-nav-toggle');
            const savedState = localStorage.getItem('sideNavState');

            if (sideNav && toggleBtn && savedState === 'collapsed') {
                sideNav.classList.add('collapsed');
                toggleBtn.classList.add('toggled'); // This line was missing
            }
        }

        function setupCatCompanion() {
            const cat = document.getElementById('cat-companion');
            const bubble = document.getElementById('cat-speech-bubble');
            if (!cat || !bubble) return;

            // Accessibility: Make it interactive for keyboard users
            cat.setAttribute('role', 'button');
            cat.setAttribute('tabindex', '0');
            cat.setAttribute('aria-label', 'Cat Companion: Click for a message');

            let bubbleTimeout;
            let animationTimeout;
            let lastIndex = -1; // Track the last message to avoid repeats

            const messages = [
                // --- Study "Encouragement" ---
                "That's a lot of reading material. Have you considered just absorbing it through osmosis while you nap? 😴",
                "I see you have a deadline. I, too, have a deadline... for my next nap.",
                "Remember to take breaks. I recommend a 4-hour break for every 15 minutes of work. It's about balance. ⚖️",
                "You look stressed. Have you tried purring? It's been shown to lower heart rate. My heart rate, specifically.",
                "Is that a textbook or a doorstop? The line is often blurry. 🤔",
                "The key to productivity is a well-placed nap on the keyboard. It forces a mandatory break.",
                "You're still here? I admire your dedication. I would have taken a nap three lectures ago.",

                // --- Grade & Course Commentary ---
                "A CC grade? Excellent. It obviously stands for 'Cat Companion' approved. 👍",
                "Don't worry about that quiz score. The only thing that truly matters is the structural integrity of this cardboard box.",
                "That final exam percentage looks... significant. 😬",
                "Final exam coming up? Sounds stressful. You should probably pet me. It helps.",
                "Ah, the homework section. Also known as the 'generous donation to my nap-time-on-warm-laptop fund'.",

                // --- Technical "Support" ---
                "Psst. I helped build this page... mostly by sitting on the keyboard.",
                "I'm not sleeping, I'm compiling. It's a very complex process. ⏳",
                "Your computer is warm. This is good. It is performing its primary function as a heated bed.",
                "I have de-bugged your code by chasing the cursor. You're welcome. 😼",
                "The page is loading slowly because the data packets have to travel around me. I am a significant physical object.",
                "I've optimized the CSS. By sleeping on the warm laptop, I prevented the human from adding more `!important` tags.",

                // --- Sassy & Interactive ---
                "Go on, click me again. I dare you. 👀",
                "I am not a button. I am a supervisor. Please show some respect.",
                "Was that click necessary? I was in the middle of a very important... thought. 🤫",
                "Ah, the human requires attention. A brief scratch behind the ears would be an acceptable offering. 👑",
                "That clicking sound from your keyboard is disrupting my nap. Please type softer.",
                "Don't worry, I'm supervising. Every click you make is being carefully monitored from this very comfortable spot.",

                // --- Philosophical Musings ---
                "The meaning of life is finding the perfect sunbeam. Everything else is just... filler. ☀️",
                "If I fits, I sits. This is the first law of feline physics.",
                "To nap, or not to nap? That is the question. And the answer is always to nap. 😌",
                "My bones are merely a suggestion. It allows for optimal napping positions.",
                "I think, therefore I am... sleepy. 🥱",

                // --- General Commentary ---
                "You work hard so I can live a life of leisure. I appreciate your contribution to my well-being.",
                "Alert! The red dot has been sighted. All other tasks are now low priority. 🔴",
                "Blinking slowly at you. That's a sign of trust, you know. 😉",
                "Need a study buddy? I'm available for moral support, provided it doesn't involve moving.",
                "I see the food bowl is only 98% full. We need to talk about these service levels. 📉",
                "Sunbeam detected on the floor. Relocating to primary charging station.",

                // --- Local Albanian Flavour ---
                "Kalofsh një ditë të bukur!",
                "Mirë se vjen!",
                "Suksese në provime! 🤞",
                "Si je? Shpresoj që ditën e ke pasur të mbarë.",
                "Mos u streso, bëj një pushim.",
                "Po vjen koha e kafes. ☕"
            ];

            const triggerCatInteraction = () => {
                // --- Easter Egg Logic ---
                const chance = 10000;
                const randomNumber = Math.floor(Math.random() * chance);

                if (randomNumber === 0) {
                    window.open('https://youtu.be/dQw4w9WgXcQ', '_blank');
                    return;
                }

                // Logic: Get a unique random index
                let randomIndex;
                do {
                    randomIndex = Math.floor(Math.random() * messages.length);
                } while (randomIndex === lastIndex && messages.length > 1);
                lastIndex = randomIndex;

                // Logic: specific handling if bubble is ALREADY visible
                if (bubble.classList.contains('visible')) {
                    // If already visible, just swap text immediately and reset the "hide" timer
                    bubble.textContent = messages[randomIndex];
                    clearTimeout(bubbleTimeout);

                    // Reset the auto-hide timer
                    bubbleTimeout = setTimeout(() => {
                        bubble.classList.remove('visible');
                    }, 6000);
                } else {
                    // If hidden, perform the standard pop-in animation
                    clearTimeout(animationTimeout); // Clear any pending open animations

                    animationTimeout = setTimeout(() => {
                        bubble.textContent = messages[randomIndex];
                        bubble.classList.add('visible');
                    }, 50); // Reduced latency from 100ms for snappier feel

                    bubbleTimeout = setTimeout(() => {
                        bubble.classList.remove('visible');
                    }, 6000);
                }
            };

            // Mouse Click Handler
            cat.addEventListener('click', (event) => {
                event.stopPropagation();
                triggerCatInteraction();
            });

            // Keyboard Handler (Enter or Space)
            cat.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault(); // Prevent page scroll on Space
                    event.stopPropagation();
                    triggerCatInteraction();
                }
            });

            // Global click listener to close bubble when clicking outside
            document.addEventListener('click', (event) => {
                // Only close if the click was NOT on the cat itself (already handled by stopPropagation, but safe to check)
                if (bubble.classList.contains('visible') && !cat.contains(event.target)) {
                    bubble.classList.remove('visible');
                }
            });
        }

        // Below 1400px the cat's fixed corner spot is gone (main.css hides it there
        // by default, handing that space to the mobile FAB). Instead of just hiding
        // it, perch it on top of the last visible module's header — re-parented as
        // a zero-height flow sibling right before that module (see .cat-perched in
        // main.css), so it rides along naturally as modules above it expand/collapse
        // or get re-sorted, with no scroll-position math to keep in sync.
        function positionCatCompanion() {
            const cat = document.getElementById('cat-companion');
            if (!cat) return;

            if (!window.matchMedia('(max-width: 1400px)').matches) {
                if (cat.classList.contains('cat-perched')) {
                    cat.classList.remove('cat-perched');
                    document.body.appendChild(cat); // restore fixed positioning's normal containing block
                }
                return;
            }

            // Always the lowest-numbered module (id="module-N"), not whichever DOM node
            // currently happens to render last — that flips (and the cat would jump
            // around) whenever the sort order toggles between ascending/descending.
            const modules = document.querySelectorAll('#course-content .module:not(.hidden)');
            let targetModule = null;
            let lowestOrder = Infinity;
            modules.forEach(m => {
                const num = parseInt((m.id || '').replace('module-', ''), 10);
                const order = isNaN(num) ? Infinity : num;
                if (order < lowestOrder) {
                    lowestOrder = order;
                    targetModule = m;
                }
            });
            if (!targetModule) targetModule = modules[modules.length - 1]; // no numeric ids at all

            if (!targetModule) {
                // No module to perch on (empty search results, etc.) — fall back to hidden.
                cat.classList.remove('cat-perched');
                document.body.appendChild(cat);
                return;
            }

            cat.classList.add('cat-perched');
            targetModule.parentNode.insertBefore(cat, targetModule);
        }

        /* Theme selector logic */
        function setupThemeToggle() {
            const KEY = 'theme-preference';
            const ICON = document.getElementById('theme-toggle-icon');
            const BTN = document.getElementById('theme-toggle');
            const icons = { auto: 'fa-solid fa-adjust', light: 'fa-regular fa-sun', dark: 'fa-regular fa-moon' };

            const getSaved = () => localStorage.getItem(KEY) || 'auto';

            const applyTheme = (pref) => {
                const html = document.documentElement;
                if (pref === 'auto') {
                    html.removeAttribute('data-theme');
                } else {
                    html.setAttribute('data-theme', pref);
                }
                localStorage.setItem(KEY, pref);
                updateUI(pref);
                updateThemeColorMeta();
            };

            const updateUI = (pref) => {
                const oldIcon = document.getElementById('theme-toggle-icon');
                if (oldIcon) {
                    const i = document.createElement('i');
                    i.id = 'theme-toggle-icon';
                    i.className = icons[pref] || icons.auto;
                    i.setAttribute('aria-hidden', 'true');
                    oldIcon.replaceWith(i);
                }
                if (BTN) {
                    const label = pref.charAt(0).toUpperCase() + pref.slice(1);
                    BTN.setAttribute('aria-label', `Theme: ${label}`);
                    BTN.title = `Theme: ${label}`;
                }
            };

            const currentIsDark = () => {
                const forced = document.documentElement.getAttribute('data-theme');
                if (forced) return forced === 'dark';
                return window.matchMedia('(prefers-color-scheme: dark)').matches;
            };

            const updateThemeColorMeta = () => {
                const meta = document.querySelector('meta[name="theme-color"]');
                if (meta) {
                    meta.setAttribute('content', currentIsDark() ? '#000000' : '#ffffff');
                }
            };

            // Apply theme on initial load
            const initialPref = getSaved();
            applyTheme(initialPref);

            // Listen for clicks on the toggle button
            if (BTN) {
                BTN.addEventListener('click', () => {
                    const currentPref = getSaved();
                    const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

                    let newPref;
                    if (currentPref === 'auto') {
                        // If we are in auto mode, switch to the opposite of the system theme
                        newPref = isSystemDark ? 'light' : 'dark';
                    } else {
                        // If we are in a manual mode (light or dark), switch back to auto
                        newPref = 'auto';
                    }
                    applyTheme(newPref);

                    // Immediately recalculate custom colors since the theme flipped
                    if (typeof window.forceThemeColorRefresh === 'function') {
                        window.forceThemeColorRefresh();
                    }
                });
            }

            // Listen for system theme changes to update UI if in auto mode
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                if (getSaved() === 'auto') {
                    applyTheme('auto');
                    // Re-apply courses theme to recalculate bright/dark contrast colors
                    if (courseData.metadata && courseData.metadata.theme_colours) {
                        applyColorTheme(courseData.metadata, true);
                    }
                }
            });

            // Expose a way to securely re-evaluate colors publicly
            window.forceThemeColorRefresh = () => {
                if (courseData.metadata && courseData.metadata.theme_colours) {
                    applyColorTheme(courseData.metadata, true);
                }
            };
        }

        function getFileTypeClass(iconClass) {
            if (!iconClass) return '';
            const icon = String(iconClass).toLowerCase();
            if (icon.includes('pdf')) return 'ft-pdf';
            if (icon.includes('word')) return 'ft-word';
            if (icon.includes('excel')) return 'ft-excel';
            if (icon.includes('csv')) return 'ft-csv';
            if (icon.includes('powerpoint')) return 'ft-powerpoint';
            if (icon.includes('image')) return 'ft-image';
            if (icon.includes('video')) return 'ft-video';
            if (icon.includes('audio')) return 'ft-audio';
            if (icon.includes('code')) return 'ft-code';
            if (icon.includes('zip') || icon.includes('archive')) return 'ft-zip';
            return '';
        }

        /* SWIPE DISABLED — start (all swipe functions) */
        // function handleDragStart(e) {
        //     if (e.pointerType && e.pointerType !== 'touch') return;
        //     const ignoredSelectors = '.project-groups-grid, #side-nav-container, .materials-grid, .course-info, .course-actions, .iframe-container, .course-buttons-container';
        //     if (e.target.closest(ignoredSelectors)) {
        //         isInsideIgnoredArea = true;
        //         return;
        //     }
        //     isInsideIgnoredArea = false;
        //     touchstartX = e.changedTouches ? e.changedTouches[0].screenX : e.screenX;
        //     touchstartY = e.changedTouches ? e.changedTouches[0].screenY : e.screenY;
        // }
        //
        // function handleDragEnd(e) {
        //     if (e.pointerType && e.pointerType !== 'touch') return;
        //     if (isInsideIgnoredArea) return;
        //     touchendX = e.changedTouches ? e.changedTouches[0].screenX : e.screenX;
        //     touchendY = e.changedTouches ? e.changedTouches[0].screenY : e.screenY;
        //     handleCourseSwipe();
        // }
        //
        // function handleCourseSwipe() {
        //     const distX = touchendX - touchstartX;
        //     const distY = touchendY - touchstartY;
        //     if (Math.abs(distX) > 75 && Math.abs(distX) > Math.abs(distY)) {
        //         const currentIndex = availableCourses.indexOf(currentCourse);
        //         let newIndex = (currentIndex + 1) % availableCourses.length;
        //         if (distX < 0) { newIndex = (currentIndex + 1) % availableCourses.length; }
        //         else { newIndex = (currentIndex - 1 + availableCourses.length) % availableCourses.length; }
        //         const newCourse = availableCourses[newIndex];
        //         if (newCourse !== currentCourse) selectCourse(newCourse);
        //     }
        // }
        //
        // function addSwipeListeners() {
        //     swipeArea.addEventListener('touchstart', handleDragStart, { passive: true });
        //     swipeArea.addEventListener('touchend', handleDragEnd, { passive: true });
        //     swipeArea.addEventListener('pointerdown', handleDragStart, { passive: true });
        //     swipeArea.addEventListener('pointerup', handleDragEnd, { passive: true });
        // }
        //
        // function removeSwipeListeners() {
        //     swipeArea.removeEventListener('touchstart', handleDragStart);
        //     swipeArea.removeEventListener('touchend', handleDragEnd);
        //     swipeArea.removeEventListener('pointerdown', handleDragStart);
        //     swipeArea.removeEventListener('pointerup', handleDragEnd);
        // }
        //
        // function setupCourseSwipe() {
        //     if (availableCourses.length < 2) return;
        //     addSwipeListeners();
        // }
        /* SWIPE DISABLED — end (all swipe functions) */

        // Save and load module states
        // Structure: { moduleId: { userInteracted: boolean, state: boolean, sheetDefault: string } }
        function saveModuleState(moduleId, isExpanded, wasUserInteraction = false) {
            const cacheKey = `moduleStates_${currentCourse}`;
            let states = {};
            try {
                const saved = localStorage.getItem(cacheKey);
                if (saved) states = JSON.parse(saved);
            } catch (e) { /* ignore parse errors */ }

            const module = document.getElementById(moduleId);
            const sheetDefault = module ? module.dataset.initiallyCollapsed : 'false';

            states[moduleId] = {
                state: isExpanded,
                userInteracted: wasUserInteraction || (states[moduleId]?.userInteracted || false),
                sheetDefault: sheetDefault
            };

            localStorage.setItem(cacheKey, JSON.stringify(states));
        }

        function loadModuleStates() {
            // Will be called after modules are rendered
        }

        function applyModuleStates() {
            const cacheKey = `moduleStates_${currentCourse}`;
            let savedStates = null;
            try {
                const saved = localStorage.getItem(cacheKey);
                if (saved) savedStates = JSON.parse(saved);
            } catch (e) { /* ignore parse errors */ }

            document.querySelectorAll('.module').forEach(module => {
                const moduleId = module.id;
                const currentSheetDefault = module.dataset.initiallyCollapsed || 'false';

                // Check if we have cached state for this module
                const cached = savedStates ? savedStates[moduleId] : null;

                // Smart logic:
                // 1. If no cached state, use sheet default
                // 2. If cached state exists but user never interacted, use sheet default
                // 3. If user interacted AND sheet default hasn't changed, use cached state
                // 4. If user interacted BUT sheet default changed, reset to new sheet default

                let useSheetDefault = true;

                if (cached && cached.userInteracted) {
                    // User explicitly interacted with this module before
                    if (cached.sheetDefault === currentSheetDefault) {
                        // Sheet default hasn't changed - respect user's preference
                        useSheetDefault = false;
                        if (cached.state) {
                            module.classList.add('active');
                        } else {
                            module.classList.remove('active');
                        }
                    }
                    // If sheet default changed, we fall through to use sheet default
                }

                if (useSheetDefault) {
                    // Use the default from the course data
                    const isInitiallyCollapsed = currentSheetDefault === 'true';
                    if (isInitiallyCollapsed) {
                        module.classList.remove('active');
                    } else {
                        module.classList.add('active');
                    }
                }
            });
        }

        function updateScrollFaders(el) {
            const scrollable = el.scrollWidth > el.clientWidth;
            el.classList.toggle('is-scrollable', scrollable);

            if (scrollable) {
                const atStart = el.scrollLeft < 5;
                const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 5;
                el.classList.toggle('at-start', atStart);
                el.classList.toggle('at-end', atEnd);
            } else {
                el.classList.remove('at-start', 'at-end');
            }
        }

        function initializeScrollFaders() {
            const scrollContainers = document.querySelectorAll('.course-buttons-container, .course-tabs-wrapper, .course-info, .course-actions, .materials-grid, .project-groups-grid, .skeleton-actions, .skeleton-tabs-wrapper, .skeleton-info-grid');
            scrollContainers.forEach(el => {
                // Check state on load
                updateScrollFaders(el);
                // Add listener to check again on scroll
                el.addEventListener('scroll', () => updateScrollFaders(el), { passive: true });
            });
        }

        // Toggle module with proper animation
        function toggleModule(moduleEl) {
            const content = moduleEl.querySelector('.module-content');
            if (!content) return;

            // Clear any inline styles to ensure scrollHeight is accurate
            content.style.maxHeight = '';

            if (moduleEl.classList.contains('active')) {
                // --- Start Closing ---
                // Set max-height to its current height, then transition to 0
                content.style.maxHeight = content.scrollHeight + 'px';
                requestAnimationFrame(() => {
                    content.style.maxHeight = '0px';
                    moduleEl.classList.remove('active');
                });
                // Save user's explicit preference (collapsing = not expanded)
                saveModuleState(moduleEl.id, false, true);
            } else {
                // --- Start Opening ---
                moduleEl.classList.add('active');
                // Set max-height to its full scrollable height
                content.style.maxHeight = content.scrollHeight + 'px';

                // After the transition ends, set max-height to 'none' 
                // This allows content inside to resize without being cropped
                const handleTransitionEnd = () => {
                    if (moduleEl.classList.contains('active')) {
                        content.style.maxHeight = 'none';
                    }
                    content.removeEventListener('transitionend', handleTransitionEnd);
                };
                content.addEventListener('transitionend', handleTransitionEnd);
                // Save user's explicit preference (expanding = expanded)
                saveModuleState(moduleEl.id, true, true);
            }
        }

        // Check URL for course hash
        function checkUrlForCourse() {
            const hash = window.location.hash.substring(1);
            if (hash && hash !== 'module-') {
                localStorage.setItem('urlSelectedCourse', hash);
            }
        }

        // Apply color theme and decoration from metadata
        function darkenHex(hex, amount = 0.25) {
            hex = hex.replace('#', '');
            if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
            const r = Math.max(0, Math.round(parseInt(hex.substring(0, 2), 16) * (1 - amount)));
            const g = Math.max(0, Math.round(parseInt(hex.substring(2, 4), 16) * (1 - amount)));
            const b = Math.max(0, Math.round(parseInt(hex.substring(4, 6), 16) * (1 - amount)));
            return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        }

        function lightenHex(hex, amount = 0.4) {
            hex = hex.replace('#', '');
            if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
            const r = Math.min(255, Math.round(parseInt(hex.substring(0, 2), 16) + (255 - parseInt(hex.substring(0, 2), 16)) * amount));
            const g = Math.min(255, Math.round(parseInt(hex.substring(2, 4), 16) + (255 - parseInt(hex.substring(2, 4), 16)) * amount));
            const b = Math.min(255, Math.round(parseInt(hex.substring(4, 6), 16) + (255 - parseInt(hex.substring(4, 6), 16)) * amount));
            return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        }

        function checkIsDarkActive() {
            const forced = document.documentElement.getAttribute('data-theme');
            if (forced) return forced === 'dark';
            return window.matchMedia('(prefers-color-scheme: dark)').matches;
        }

        function applyColorTheme(metadata, isBackgroundRefresh = false) {
            if (metadata.theme_colours) {
                const isDark = checkIsDarkActive();
                // We MUST copy the array so we don't accidentally poison the permanently cached Javascript data Object
                const originalColors = metadata.theme_colours.split(',').map(c => c.trim());
                let colors = [...originalColors];

                // In dark mode, slightly bump brightness to avoid merging into the #121212 background, but keep it mostly original
                if (isDark) {
                    colors = colors.map(c => lightenHex(c, 0.1)); // Reduced from 0.45 to 0.1 to avoid desaturation
                }

                if (colors.length >= 5) {
                    document.body.setAttribute('data-theme-color', 'custom');
                    document.documentElement.style.setProperty('--theme-primary', colors[0]);
                    document.documentElement.style.setProperty('--theme-primary-dark', isDark ? lightenHex(colors[0], 0.2) : darkenHex(colors[0], 0.25));
                    // Keep the header distinct regardless of theme
                    if (isDark) {
                        document.documentElement.style.setProperty('--course-header-bg1', darkenHex(colors[0], 0.4));
                        document.documentElement.style.setProperty('--course-header-bg2', darkenHex(colors[0], 0.6));
                    } else {
                        document.documentElement.style.setProperty('--course-header-bg1', colors[0]);
                        document.documentElement.style.setProperty('--course-header-bg2', darkenHex(colors[0], 0.25));
                    }

                    document.documentElement.style.setProperty('--theme-secondary', colors[1]);
                    document.documentElement.style.setProperty('--theme-tertiary', colors[2]);
                    document.documentElement.style.setProperty('--theme-accent', colors[3]);
                    document.documentElement.style.setProperty('--theme-success', colors[4]);
                }
            } else {
                document.body.removeAttribute('data-theme-color');
                // Clear any previously set custom properties to prevent cross-course contamination
                ['--theme-primary', '--theme-primary-dark', '--course-header-bg1', '--course-header-bg2', '--theme-secondary', '--theme-tertiary', '--theme-accent', '--theme-success'].forEach(prop => {
                    document.documentElement.style.removeProperty(prop);
                });
            }

            const decorationContainer = document.getElementById('header-decoration');
            const newIconClass = metadata.header_decoration?.toLowerCase() || 'fa-square';
            const isFirstLoad = !decorationContainer.dataset.currentIcon;

            // Background refresh without icon change shouldn't trigger animation
            if (isBackgroundRefresh && !isFirstLoad && decorationContainer.dataset.currentIcon === newIconClass) {
                return;
            }

            // This function will change the icon and trigger the "pop-in" animation
            const animateIn = () => {
                decorationContainer.dataset.currentIcon = newIconClass;
                decorationContainer.innerHTML = `<i class="fa-solid ${newIconClass}"></i>`;
                decorationContainer.style.animation = 'decor-pop-in 0.4s cubic-bezier(0.68, -0.55, 0.27, 1.55) forwards';
            };

            if (isFirstLoad) {
                // On the very first page load, just animate the icon in after a brief delay
                setTimeout(animateIn, 150);
            } else {
                // When switching courses, first trigger the "pop-out" animation
                decorationContainer.style.animation = 'decor-pop-out 0.25s ease-in forwards';

                // Add a listener that waits for the animation to end
                decorationContainer.addEventListener('animationend', function handleAnimationEnd() {
                    // Once the pop-out is finished, call the function to pop the new one in
                    animateIn();

                    // IMPORTANT: Remove the listener so it only runs once
                    decorationContainer.removeEventListener('animationend', handleAnimationEnd);
                });
            }
        }

        function showMainContent() {
            const loadingIndicator = document.getElementById('app-loading');
            const mainContainer = document.getElementById('main-container');
            if (loadingIndicator) {
                loadingIndicator.style.opacity = '0';
                setTimeout(() => { loadingIndicator.style.display = 'none'; }, 500);
            }
            if (mainContainer) {
                mainContainer.classList.remove('content-hidden');

                // Release the temporary minHeight locks placed by handleArchiveToggle
                const courseContent = document.getElementById('course-content');
                const courseButtons = document.getElementById('course-buttons-container');
                if (courseContent) courseContent.style.minHeight = '';
                if (courseButtons) courseButtons.style.minHeight = '';
            }
        }

        function initContainers() {
            // This reliably hides the timetable container on page load.
            const timetableContainer = document.getElementById('timetable-container');
            if (timetableContainer) {
                timetableContainer.style.display = 'none';
            }

            // Delegated once on the (never-replaced) container — safe across
            // every innerHTML swap loadTimetable() does inside it.
            const nativeContainer = document.getElementById('native-timetable-container');
            if (nativeContainer) {
                wireTimetableTooltips(nativeContainer);
            }

            // Re-fit the timetable, and re-check the cat's perch breakpoint, on resize / orientation change.
            let ttResizeTimer;
            window.addEventListener('resize', () => {
                clearTimeout(ttResizeTimer);
                ttResizeTimer = setTimeout(() => {
                    const c = document.getElementById('native-timetable-container');
                    if (c && c.classList.contains('visible')) fitTimetable(c);
                    positionCatCompanion();
                }, 150);
            });
        }

        // The timetable/class pair currently shown (or being fetched); lets a
        // late fetch response recognise it has been superseded or dismissed.
        let activeTimetableKey = null;

        // Remembers, per course, whether a timetable was left open and which
        // one — same pattern as moduleStates_/courseSortOrders, keyed off
        // currentCourse so switching courses (or reloading on one) restores
        // exactly what that course's link last showed.
        function saveTimetableState(open, index) {
            const cacheKey = `timetableState_${currentCourse}`;
            try {
                if (open) localStorage.setItem(cacheKey, JSON.stringify({ open: true, index }));
                else localStorage.removeItem(cacheKey);
            } catch (e) { /* ignore */ }
        }

        function restoreTimetableState() {
            let saved = null;
            try { saved = JSON.parse(localStorage.getItem(`timetableState_${currentCourse}`)); } catch (e) { /* ignore */ }
            if (!saved || !saved.open) return;
            const btn = document.getElementById(`timetable-btn-${saved.index}`);
            if (btn) toggleTimetable(saved.index, btn.dataset.btnName || 'Timetable');
        }

        async function toggleTimetable(index, btnName) {
            const timetableContainer = document.getElementById("timetable-container");
            const container = document.getElementById("native-timetable-container");
            const inner = container.querySelector('.tt-inner');

            const clickedButton = document.getElementById(`timetable-btn-${index}`);
            const targetTimetableId = clickedButton.dataset.timetableId;
            const targetClassId = clickedButton.dataset.classId;

            const isCurrentlyActive = clickedButton.classList.contains('active');
            const allTimetableBtns = document.querySelectorAll('.timetable-btn');

            if (isCurrentlyActive) {
                // --- HIDING THE CURRENTLY OPEN TIMETABLE ---
                activeTimetableKey = null;
                saveTimetableState(false);
                hideTtPopover();
                container.classList.remove('visible'); // animates the collapse
                clickedButton.innerHTML = `<i class="fa-solid fa-calendar-week"></i> ${btnName}`;
                clickedButton.classList.remove('active');

                // Wait for the actual collapse transition to finish (rather than a
                // setTimeout guessing its duration) before pulling the outer wrapper
                // out of the document with display:none. A timer that merely matches
                // the CSS duration on paper drifts under real load — exactly while a
                // big table is being clipped/repainted — firing early and snapping
                // the tail of the animation off. Listening for the real event can't
                // drift, and the fallback timer is just a safety net if the
                // transition never fires at all (e.g. reduced-motion).
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    container.removeEventListener('transitionend', onEnd);
                    clearTimeout(fallback);
                    // Only fully hide if nothing new was opened during the collapse.
                    if (!activeTimetableKey) timetableContainer.style.display = 'none';
                };
                const onEnd = e => { if (e.target === container && e.propertyName === 'grid-template-rows') finish(); };
                container.addEventListener('transitionend', onEnd);
                const fallback = setTimeout(finish, 600);
                return;
            }

            // --- SHOWING OR SWITCHING ---
            allTimetableBtns.forEach(btn => {
                btn.classList.remove('active');
                btn.innerHTML = `<i class="fa-solid fa-calendar-week"></i> ${btn.dataset.btnName || 'Timetable'}`;
            });
            clickedButton.innerHTML = `<i class="fa-solid fa-calendar-xmark"></i> ${btnName}`;
            clickedButton.classList.add('active');

            const requestKey = `${targetTimetableId || ''}::${targetClassId || ''}`;
            activeTimetableKey = requestKey;
            saveTimetableState(true, index);

            timetableContainer.style.display = '';
            inner.innerHTML = '<div class="iframe-loader"></div>';
            // Force a reflow so the collapsed (0fr) state is committed as the
            // transition's start value before .visible flips it to 1fr —
            // otherwise the browser coalesces both and skips the open animation
            // (rAF alone is unreliable coming out of a display:none subtree).
            void container.offsetHeight;
            container.classList.add('visible');

            try {
                // Supabase Edge Function proxies EIS (which sends no CORS headers)
                // and returns the extracted table fragment. verify_jwt is off for
                // this function (see supabase/config.toml) — it's a public,
                // read-only proxy invoked straight from the browser, and a CORS
                // preflight can never carry these headers anyway. Sent for
                // consistency with the rest of the page's Supabase calls, though
                // the function itself doesn't require them.
                const response = await fetch(
                    `${SUPABASE_URL}/functions/v1/eis-timetable?tId=${encodeURIComponent(targetTimetableId || '')}&cId=${encodeURIComponent(targetClassId || '')}`,
                    { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } }
                );
                if (!response.ok) throw new Error(`HTTP error ${response.status}`);
                const html = await response.text();
                // The user may have switched timetables (or closed this one)
                // while the request was in flight — drop stale responses.
                if (activeTimetableKey !== requestKey) return;
                if (!html.includes('<table')) {
                    inner.innerHTML = html.includes('tt-error')
                        ? DOMPurify.sanitize(html)
                        : '<div class="tt-error">No timetable found for this class.</div>';
                    return;
                }
                // The proxy already strips <script> tags, but that alone isn't full
                // sanitization — this is the real defense-in-depth layer against
                // anything else executable, in case EIS's own page ever changes.
                // FORCE_BODY is required for ADD_TAGS:['style'] to actually stick —
                // without it DOMPurify treats <style> as document metadata and drops
                // it regardless of the allowlist, since the fragment isn't a full page.
                inner.innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ['style'], FORCE_BODY: true });
                fitTimetable(container);
            } catch (error) {
                console.error('Timetable load error:', error);
                if (activeTimetableKey !== requestKey) return;
                inner.innerHTML = '<div class="tt-error">Could not load the timetable. Please try again later.</div>';
            }
        }

        // Trims dead weight from the EIS table before fitting:
        //   • Time columns: empty ones are trimmed off BOTH ends, right up to
        //     the first and last lecture — never in between. The Week and Day
        //     columns (0 and 1) are always kept.
        //   • Rows: left untouched EXCEPT an empty Saturday, which is removed.
        //     Other empty days stay — a two-week exam timetable must keep its
        //     shape, so we don't collapse arbitrary blank days.
        // Idempotent, so re-running on resize is safe.
        function pruneTimetable(table) {
            const rows = Array.from(table.rows);
            const isCourse = cell => !!(cell.querySelector && cell.querySelector('.timetable-day-course'));

            // Occupancy matrix resolving colspan/rowspan into real column indexes
            // (matrix[row][col] = the cell covering that slot).
            const matrix = [];
            rows.forEach((tr, r) => {
                matrix[r] = matrix[r] || [];
                let c = 0;
                for (const cell of tr.cells) {
                    while (matrix[r][c] !== undefined) c++;
                    const cs = cell.colSpan || 1, rs = cell.rowSpan || 1;
                    for (let i = 0; i < rs; i++) {
                        matrix[r + i] = matrix[r + i] || [];
                        for (let j = 0; j < cs; j++) matrix[r + i][c + j] = cell;
                    }
                    c += cs;
                }
            });

            // --- Trim empty time columns off both ends (cols 0/1 = Week/Day) ---
            let firstUsed = Infinity, lastUsed = -Infinity;
            matrix.forEach(row => row.forEach((cell, c) => {
                if (c >= 2 && cell && isCourse(cell)) {
                    firstUsed = Math.min(firstUsed, c);
                    lastUsed = Math.max(lastUsed, c);
                }
            }));

            if (lastUsed >= 2) {
                // Trim empty time columns right up to the first and last lecture
                // (no padding column on either side).
                const leftKeep = firstUsed;
                const rightKeep = lastUsed;
                const kept = c => c < 2 || (c >= leftKeep && c <= rightKeep);

                const handled = new Set();
                matrix.forEach(row => {
                    row.forEach((cell, c) => {
                        if (!cell || handled.has(cell)) return;
                        handled.add(cell);
                        const start = row.indexOf(cell);
                        const span = cell.colSpan || 1;
                        let keptCols = 0;
                        for (let k = start; k < start + span; k++) if (kept(k)) keptCols++;
                        if (keptCols === 0) cell.remove();
                        else if (keptCols < span) cell.colSpan = keptCols;
                    });
                });
            }

            // --- Remove an empty Saturday row-group only ---
            // Group tbody rows by their day cell (matrix column 1); each week's
            // Saturday is its own cell, so multi-week tables are handled too.
            const groups = new Map();
            rows.forEach((tr, r) => {
                if (tr.parentElement.tagName !== 'TBODY') return;
                const dayCell = matrix[r][1];
                if (!dayCell) return;
                if (!groups.has(dayCell)) groups.set(dayCell, []);
                groups.get(dayCell).push(r);
            });
            groups.forEach((rIdxs, dayCell) => {
                if (!/saturday/i.test(dayCell.textContent || '')) return; // only Saturday
                const hasCourse = rIdxs.some(r => matrix[r].some((cell, c) => c >= 2 && cell && isCourse(cell)));
                if (hasCourse) return; // keep a Saturday that actually has lectures
                const weekCell = matrix[rIdxs[0]][0];
                // Never remove the rows that *define* the week-number cell.
                if (weekCell && rIdxs.some(r => Array.from(rows[r].cells).includes(weekCell))) return;
                rIdxs.forEach(r => rows[r].remove());
                if (weekCell) weekCell.rowSpan = Math.max(1, weekCell.rowSpan - rIdxs.length);
            });

            // --- Drop the Week column when the timetable spans a single week ---
            // The week-number cells are the numeric <th>s in the body; one means
            // one week, so the whole column (its header + that cell) is dead.
            const body = table.tBodies[0];
            if (body) {
                const weekCells = Array.from(body.querySelectorAll('th'))
                    .filter(th => /^\s*\d+\s*$/.test(th.textContent || ''));
                if (weekCells.length === 1) {
                    weekCells[0].remove();
                    const headRow = table.tHead && table.tHead.rows[0];
                    const weekHead = headRow && headRow.cells[0];
                    if (weekHead && /week/i.test(weekHead.textContent || '')) weekHead.remove();
                }
            }
        }

        // Shortens day names to Mon/Tue/… so the Day column can be as narrow as
        // the time columns. Must run AFTER pruneTimetable (which matches the
        // Saturday row by its full name) and BEFORE equalizeColumns (which
        // measures column widths off the current text) — the column would
        // otherwise stay sized for "Wednesday" even after the label shortens.
        function abbreviateDays(table) {
            const body = table.tBodies[0];
            if (!body) return;
            const ABBR = {
                monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
                friday: 'Fri', saturday: 'Sat', sunday: 'Sun'
            };
            Array.from(body.rows).forEach(row => {
                Array.from(row.cells).forEach(cell => {
                    if (cell.tagName !== 'TH') return;
                    const key = (cell.textContent || '').trim().toLowerCase();
                    if (ABBR[key]) cell.textContent = ABBR[key];
                });
            });
        }

        // Gives every time column the same width (distributed equally), keeping
        // the total time-width the same so the fit scale — and thus the on-screen
        // text size — is unchanged. Content that no longer fits a column is cut
        // off with an ellipsis (see the .tt-fitted CSS). The Week/Day columns are
        // left at their natural width; only the time slots are equalised.
        function equalizeColumns(table) {
            const head = table.tHead && table.tHead.rows[0];
            if (!head) return;
            const cells = Array.from(head.cells);
            // Clear any widths from a previous run so the auto measurement below
            // reflects real content, not last time's equalised columns.
            cells.forEach(c => { c.style.width = ''; });
            table.style.tableLayout = 'auto';
            table.style.width = 'auto';
            const isTime = c => /\d{1,2}:\d{2}/.test(c.textContent || '');
            const timeCells = cells.filter(isTime);
            const fixedCells = cells.filter(c => !isTime(c));
            if (timeCells.length < 2) return;

            const fixedWidths = fixedCells.map(c => Math.ceil(c.getBoundingClientRect().width));
            const totalTimeW = timeCells.reduce((s, c) => s + c.getBoundingClientRect().width, 0);
            const n = timeCells.length;
            const colW = Math.max(44, Math.round(totalTimeW / n));
            const fixedTotal = fixedWidths.reduce((a, b) => a + b, 0);

            table.style.tableLayout = 'fixed';
            table.style.width = (fixedTotal + n * colW) + 'px';
            fixedCells.forEach((c, i) => { c.style.width = fixedWidths[i] + 'px'; });
            timeCells.forEach(c => { c.style.width = colW + 'px'; });
        }

        // Forces the EIS fragment's full desktop presentation (course names +
        // room details, not the stripped mobile view) and scales the whole
        // table down so it always fits the container width — no horizontal
        // scrollbar, nothing hidden. On wide screens where it already fits, it
        // just fills the container like a normal table (no scaling).
        function fitTimetable(container) {
            const inner = container.querySelector('.tt-inner');
            const table = inner && inner.querySelector('table');
            if (!table) return;
            inner.classList.add('tt-fitted');
            pruneTimetable(table);
            abbreviateDays(table);
            equalizeColumns(table);

            // Wrap the table once so the wrapper can clip its unscaled layout box
            // (a CSS transform doesn't shrink the space the element reserves).
            let wrap = inner.querySelector('.tt-scale-wrap');
            if (!wrap || table.parentNode !== wrap) {
                wrap = document.createElement('div');
                wrap.className = 'tt-scale-wrap';
                table.parentNode.insertBefore(wrap, table);
                wrap.appendChild(table);
            }

            // Measure at natural width, then fill (wide) or scale down (narrow).
            table.style.transform = 'none';
            // width/tableLayout were set by equalizeColumns; measure that.
            const naturalW = table.offsetWidth;
            const avail = wrap.clientWidth;
            if (naturalW <= avail) {
                table.style.width = '100%';
                wrap.style.height = '';
            } else {
                const scale = avail / naturalW;
                const naturalH = table.offsetHeight;
                table.style.transform = `scale(${scale})`;
                wrap.style.height = (naturalH * scale) + 'px';
            }
        }

        // --- Timetable cell "more info" popover ---
        // EIS's own page shows this on click via tippy.js + jQuery, loaded from
        // its own site — none of which we pull in (and we strip <script> tags
        // from the proxied fragment on purpose). Each course cell still carries
        // its data-tippy-html attribute though (plain data, not a script), so we
        // read that directly and render our own lightweight popover instead.
        let ttPopoverEl = null;
        let ttOpenedAt = 0;

        function ensureTtPopover() {
            if (ttPopoverEl) return ttPopoverEl;
            ttPopoverEl = document.createElement('div');
            ttPopoverEl.className = 'tt-popover';
            ttPopoverEl.innerHTML = '<button type="button" class="tt-popover-close" aria-label="Close">&times;</button><div class="tt-popover-body"></div>';
            document.body.appendChild(ttPopoverEl);
            ttPopoverEl.querySelector('.tt-popover-close').onclick = hideTtPopover;
            return ttPopoverEl;
        }

        function hideTtPopover() {
            if (ttPopoverEl) {
                ttPopoverEl.classList.remove('visible');
                ttPopoverEl._forCell = null;
            }
        }

        function showTtPopover(cell) {
            const raw = cell.dataset.tippyHtml;
            if (!raw) return;
            const popover = ensureTtPopover();
            // Sanitized separately here: the initial DOMPurify pass over the
            // fragment doesn't recurse into data-* attribute values, so this
            // string was never actually sanitized until now.
            popover.querySelector('.tt-popover-body').innerHTML =
                DOMPurify.sanitize(raw, { ADD_TAGS: ['style'], FORCE_BODY: true });
            popover.classList.add('visible');
            popover._forCell = cell;
            ttOpenedAt = Date.now();

            const margin = 10;
            const rect = cell.getBoundingClientRect();
            const popW = popover.offsetWidth;
            const popH = popover.offsetHeight;

            let left = rect.left + rect.width / 2 - popW / 2;
            left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin));

            let top = rect.bottom + 8;
            if (top + popH > window.innerHeight - margin) top = rect.top - popH - 8;
            top = Math.max(margin, top);

            popover.style.left = `${left}px`;
            popover.style.top = `${top}px`;
        }

        function wireTimetableTooltips(container) {
            container.addEventListener('click', e => {
                const cell = e.target.closest('[data-tippy-html]');
                if (!cell) return;
                e.stopPropagation();
                if (ttPopoverEl && ttPopoverEl.classList.contains('visible') && ttPopoverEl._forCell === cell) {
                    hideTtPopover();
                    return;
                }
                showTtPopover(cell);
            });

            // Dismiss on outside click, Escape, or scroll (a fixed-position
            // popover would otherwise drift away from the cell it's anchored to).
            document.addEventListener('click', e => {
                if (ttPopoverEl && ttPopoverEl.classList.contains('visible') && !ttPopoverEl.contains(e.target)) {
                    hideTtPopover();
                }
            });
            document.addEventListener('keydown', e => {
                if (e.key === 'Escape') hideTtPopover();
            });
            // Ignore scrolls fired by the opening tap itself (mobile taps often
            // emit a tiny scroll) — only genuine later scrolls dismiss it.
            window.addEventListener('scroll', () => {
                if (Date.now() - ttOpenedAt > 400) hideTtPopover();
            }, { passive: true, capture: true });
        }

        /**
         * Initialize backend connection and load courses
         */
        function initBackend() {
            tryPublicAccess().then(success => {
                if (success) {
                    showMainContent();
                } else {
                    showImprovedNotification('error', 'Connection Error', 'Failed to connect to backend.');
                    showMainContent();
                }
            }).catch(() => {
                showImprovedNotification('error', 'Connection Error', 'Failed to connect to backend.');
                showMainContent();
            });
        }

        // Shared helper: select the best initial course based on URL hash and localStorage
        function selectInitialCourse() {
            if (availableCourses.length === 0) return;
            const urlCourse = localStorage.getItem('urlSelectedCourse');
            const prefix = isArchiveMode ? 'archive_' : 'active_';
            const lastCourse = localStorage.getItem(prefix + 'lastSelectedCourse');

            // Try to match the hash first natively, then fallback to LocalStorage url caching, then the last remembered course for this specific mode
            const hash = window.location.hash.substring(1);

            selectCourse(
                // HIGHEST PRIORITY: The literal URL hash we are currently visiting (if valid for this context)
                (hash && availableCourses.includes(hash)) ? hash :
                    // SECOND: The cached URL course if we survived a bounce from tryPublicAccess
                    (urlCourse && availableCourses.includes(urlCourse) ? urlCourse :
                        // THIRD: The last course the user looked at in this context (Active vs Archive)
                        (lastCourse && availableCourses.includes(lastCourse) ? lastCourse : availableCourses[0]))
            );
            localStorage.removeItem('urlSelectedCourse');
        }

        async function tryPublicAccess() {
            try {
                const response = await sbFetch(
                    `course_rows?type=eq.metadata&is_archive=eq.${isArchiveMode}&select=sheet_name,b,c&order=sheet_name`
                );
                if (!response.ok) return false;
                const rows = await response.json();
                if (!rows.length) return false;

                const seen = new Set();
                availableCourses = [];
                const codes = {};
                rows.forEach(r => {
                    if (!seen.has(r.sheet_name)) { seen.add(r.sheet_name); availableCourses.push(r.sheet_name); }
                    if (r.b === 'code') codes[r.sheet_name] = r.c;
                });

                if (availableCourses.length === 0) return false;

                Object.assign(courseMap, codes);
                try {
                    localStorage.setItem(getCachePrefix() + 'courseCodesCache', JSON.stringify({ data: codes, timestamp: Date.now() }));
                } catch (e) { }

                await populateCourseButtons();

                const hash = window.location.hash.substring(1);
                if (hash && hash !== 'module-' && !availableCourses.includes(hash)) {
                    if (!isArchiveMode && !new URLSearchParams(window.location.search).has('archive')) {
                        isArchiveMode = true;
                        const url = new URL(window.location);
                        url.searchParams.set('archive', '');
                        let newUrlString = url.toString().replace(/archive=(&|$)/, 'archive$1');
                        window.history.replaceState({ archive: true }, '', newUrlString || url);
                        resetForModeSwitch();
                        return true;
                    }
                }

                selectInitialCourse();
                return true;
            } catch (error) {
                console.error('Error during Supabase access:', error);
                return false;
            }
        }

        const SUPABASE_URL = window.TEACHING_CONFIG.supabaseUrl;
        const SUPABASE_ANON_KEY = window.TEACHING_CONFIG.supabaseAnonKey;

        function sbFetch(endpoint) {
            return fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
                headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
            });
        }

        async function fetchPublicSheetData(sheetName) {
            const response = await sbFetch(
                `course_rows?sheet_name=eq.${encodeURIComponent(sheetName)}&is_archive=eq.${isArchiveMode}&order=row_index&select=type,b,c,d,e,f,g,h,i,j`
            );
            if (!response.ok) throw new Error(`Supabase error ${response.status}`);
            const rows = await response.json();
            return rows.map(r => [r.type, r.b, r.c, r.d, r.e, r.f, r.g, r.h, r.i, r.j]);
        }



        function formatCourseCode(code) {
            return code.replace(/_/g, ' ');
        }

        async function populateCourseButtons() {
            // setupCourseSwipe(); /* SWIPE DISABLED */
            const container = document.getElementById('course-buttons-container');
            if (!container) return;
            container.innerHTML = '';

            // Shared helper to create a single course button
            const createCourseButton = (sheetName, label) => {
                const button = document.createElement('div');
                button.setAttribute('class', 'course-button' + (currentCourse === sheetName ? ' active' : ''));
                button.innerHTML = `<i class="fa-solid fa-th-list"></i>&nbsp; ${formatCourseCode(label)}`;
                button.dataset.sheet = sheetName;
                button.onclick = () => selectCourse(sheetName);
                return button;
            };

            const createArchiveButton = () => {
                const button = document.createElement('div');
                // Use the standard course-button classes but add an extra style target if needed
                button.setAttribute('class', 'course-button archive-course-btn');

                // Style the button identically to courses so it lives right next to them
                if (isArchiveMode) {
                    button.innerHTML = `<i class="fa-solid fa-arrow-left"></i><span class="desktop-only">&nbsp; Back</span>`;
                    button.title = 'Back to Active Courses';
                } else {
                    button.innerHTML = `<i class="fa-solid fa-box-archive"></i><span class="desktop-only">&nbsp; Archives</span>`;
                    button.title = 'View Past Courses';
                }

                button.onclick = handleArchiveToggle;

                // Optional: apply a slight ghost appearance so it doesn't shout as loudly as your main courses
                if (!isArchiveMode) {
                    button.style.backgroundColor = 'transparent';
                    button.style.border = '1px solid #e0e0e0';
                    button.style.color = '#757575';
                    button.style.boxShadow = 'none';
                } else {
                    // For the back button, keep standard styling to clearly show it's clickable
                    button.style.backgroundColor = 'transparent';
                    button.style.border = '1px solid var(--primary-color)';
                    button.style.color = 'var(--primary-color)';
                    button.style.boxShadow = 'none';
                }

                return button;
            };

            const updateFaderForButtons = () => {
                const tabsWrapper = container.querySelector('.course-tabs-wrapper');
                if (tabsWrapper) updateScrollFaders(tabsWrapper);
            };

            const renderButtons = (useCourseMap) => {
                const archiveBtn = createArchiveButton();



                // An inner wrapper keeps the course tabs isolated geographically from the Back button
                // so that when rows wrap, they stay aligned to their own left edge.
                const tabsWrapper = document.createElement('div');
                tabsWrapper.setAttribute('class', 'course-tabs-wrapper');
                tabsWrapper.addEventListener('scroll', () => updateScrollFaders(tabsWrapper), { passive: true });

                availableCourses.forEach((sheetName, index) => {
                    const label = useCourseMap ? (courseMap[sheetName] || sheetName) : sheetName;
                    const btn = createCourseButton(sheetName, label);

                    if (availableCourses.length === 1) {
                        btn.style.borderRadius = '20px';
                    } else {
                        if (index === 0) btn.style.borderRadius = '20px 8px 8px 20px';
                        if (index === availableCourses.length - 1) btn.style.borderRadius = '8px 20px 20px 8px';
                    }

                    tabsWrapper.appendChild(btn);
                });

                if (archiveBtn) archiveBtn.style.marginLeft = '2px';

                // Clear the container before re-adding everything
                container.innerHTML = '';
                container.appendChild(tabsWrapper);
                if (archiveBtn) container.appendChild(archiveBtn);

                updateFaderForButtons();

                // Track wrapped rows specifically on the tabs wrapper so it ignores Back/Archive
                if (!tabsWrapper._resizeObserver) {
                    tabsWrapper._resizeObserver = new ResizeObserver(() => updateButtonRows(tabsWrapper));
                    tabsWrapper._resizeObserver.observe(tabsWrapper);
                } else {
                    updateButtonRows(tabsWrapper);
                }
            };

            try {
                await fetchCourseCodes();
                renderButtons(true);
            } catch (err) {
                renderButtons(false);
            }
        }

        // Dynamically tags info-item chips in .course-info by which visual row they sit on
        function updateInfoItemRows() {
            const courseInfoEl = document.getElementById('course-info');
            if (!courseInfoEl) return;

            // Collect ALL .info-item descendants (professors-container has display:contents
            // so its children participate in the same flex row as the direct .info-item spans)
            const items = Array.from(courseInfoEl.querySelectorAll('.info-item'))
                .filter(el => el.offsetParent !== null); // skip hidden elements

            // Wipe existing row classes
            items.forEach(el => {
                el.classList.remove('first-in-row', 'last-in-row', 'only-in-row', 'middle-in-row');
            });

            if (items.length === 0) return;

            // Group by offsetTop (fuzzy ±5px for subpixel zoom)
            const rows = {};
            items.forEach(el => {
                const top = el.offsetTop;
                const existingKey = Object.keys(rows).find(k => Math.abs(parseInt(k) - top) < 5);
                if (existingKey) {
                    rows[existingKey].push(el);
                } else {
                    rows[top] = [el];
                }
            });

            const rowArrays = Object.values(rows);
            rowArrays.sort((a, b) => a[0].offsetTop - b[0].offsetTop);

            rowArrays.forEach((rowItems, index) => {
                if (rowItems.length === 1) {
                    rowItems[0].classList.add(index === 0 ? 'only-in-row' : 'middle-in-row');
                } else {
                    rowItems[0].classList.add('first-in-row');
                    rowItems[rowItems.length - 1].classList.add('last-in-row');
                }
            });
        }

        // Dynamically tags buttons that fall onto new lines so CSS can round their outer edges
        function updateButtonRows(container) {
            const buttons = Array.from(container.children).filter(b => b.style.display !== 'none');
            if (buttons.length === 0) return;

            // Wipe slate clean
            buttons.forEach(b => {
                b.classList.remove('first-in-row', 'last-in-row', 'only-in-row', 'grow-row', 'middle-in-row');
            });

            // Group buttons by their vertical row coordinate with a fuzzy threshold to account for subpixel zooming quirks
            const rows = {};
            buttons.forEach(btn => {
                const top = btn.offsetTop;
                const existingRowKey = Object.keys(rows).find(k => Math.abs(parseInt(k) - top) < 5);

                if (existingRowKey) {
                    rows[existingRowKey].push(btn);
                } else {
                    rows[top] = [btn];
                }
            });

            // Assign tags based on row makeup
            const rowArrays = Object.values(rows);
            // Sort rows by their vertical position to ensure reliable index order
            rowArrays.sort((a, b) => a[0].offsetTop - b[0].offsetTop);

            rowArrays.forEach((rowButtons, index) => {
                if (rowButtons.length === 1) {
                    if (index === 0) {
                        rowButtons[0].classList.add('only-in-row'); // Fully round isolated buttons on first line
                    } else {
                        rowButtons[0].classList.add('middle-in-row'); // Treat solitary wrapped buttons as middle
                    }
                } else if (rowButtons.length > 1) {
                    rowButtons[0].classList.add('first-in-row');
                    rowButtons[rowButtons.length - 1].classList.add('last-in-row');
                }
            });
        }

        async function fetchCourseCodes() {
            const prefix = getCachePrefix();
            const CACHE_KEY = prefix + 'courseCodesCache';
            const CACHE_EXPIRY = 5 * 60 * 1000;

            try {
                const cached = localStorage.getItem(CACHE_KEY);
                if (cached) {
                    const { data, timestamp } = JSON.parse(cached);
                    if (Date.now() - timestamp < CACHE_EXPIRY) { Object.assign(courseMap, data); return courseMap; }
                }
            } catch (e) { }

            try {
                const response = await sbFetch(
                    `course_rows?type=eq.metadata&b=eq.code&is_archive=eq.${isArchiveMode}&select=sheet_name,c`
                );
                if (response.ok) {
                    const rows = await response.json();
                    const codes = {};
                    rows.forEach(r => { codes[r.sheet_name] = r.c; });
                    Object.assign(courseMap, codes);
                    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data: codes, timestamp: Date.now() })); } catch (e) { }
                    return courseMap;
                }
            } catch (error) {
                console.error('Course codes fetch failed:', error);
            }

            availableCourses.forEach(sheetName => { if (!courseMap[sheetName]) courseMap[sheetName] = sheetName; });
            return courseMap;
        }

        function setupSearchFilter() {
            const searchBar = document.getElementById('search-bar');
            if (!searchBar) return;

            searchBar.addEventListener('input', () => {
                const query = searchBar.value.toLowerCase().trim();
                const modules = document.querySelectorAll('.module');

                let visibleModules = 0;
                modules.forEach(module => {
                    const moduleTitle = module.querySelector('.module-title')?.textContent.toLowerCase() || '';
                    const materialCards = module.querySelectorAll('.material-card');
                    let hasMatch = moduleTitle.includes(query);

                    materialCards.forEach(card => {
                        const materialTitle = card.querySelector('.material-title')?.textContent.toLowerCase() || '';
                        const materialDesc = card.querySelector('.material-description')?.textContent.toLowerCase() || '';
                        if (materialTitle.includes(query) || materialDesc.includes(query)) {
                            hasMatch = true;
                        }
                    });

                    const projectGroupCards = module.querySelectorAll('.project-group-card');
                    projectGroupCards.forEach(card => {
                        const topic = card.querySelector('.project-group-title')?.textContent.toLowerCase() || '';
                        const description = card.querySelector('.project-group-description')?.textContent.toLowerCase() || '';
                        if (topic.includes(query) || description.includes(query)) {
                            hasMatch = true;
                        }
                    });

                    if (hasMatch) {
                        module.classList.remove('hidden');
                        visibleModules++;
                    } else {
                        module.classList.add('hidden');
                    }
                });

                let noResultsEl = document.getElementById('no-search-results');
                if (visibleModules === 0 && !noResultsEl) {
                    noResultsEl = document.createElement('div');
                    noResultsEl.id = 'no-search-results';
                    noResultsEl.setAttribute('class', 'empty-content');
                    noResultsEl.innerHTML = '<i class="fa-solid fa-search"></i><br>No modules match your search.';
                    document.getElementById('course-content').appendChild(noResultsEl);
                } else if (visibleModules > 0 && noResultsEl) {
                    noResultsEl.remove();
                }

                positionCatCompanion();
            });
        }

        function selectCourse(sheetName) {
            // If not the initial load, start the loading state
            if (currentCourse) {
                document.body.classList.add('is-switching');
            }
            document.body.classList.remove('theme-ready'); // Hide themed elements to prevent flash

            const prefix = isArchiveMode ? 'archive_' : 'active_';
            localStorage.setItem(prefix + 'lastSelectedCourse', sheetName);
            currentCourse = sheetName;
            window.location.hash = sheetName;

            // Remove fab-visible so it re-animates on new course load
            const fabEl = document.getElementById('mobile-fab');
            if (fabEl) fabEl.classList.remove('fab-visible');

            resetUIElements();
            document.querySelectorAll('.course-button').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.sheet === sheetName);
            });

            fetchCourseData(sheetName).then(data => {
                if (data) {
                    Object.assign(courseData, data);
                    window.currentCourseData = data; // Expose globally for dismissal re-renders

                    let titleBase = data.metadata.code ? `${formatCourseCode(data.metadata.code)} ${data.metadata.title || 'Course'}` : 'Course Materials';
                    let announcementCount = 0;
                    document.title = titleBase;

                    updateCourseMetadata(data.metadata);
                    populateActionButtons(data.actionButtons, data.metadata);
                    restoreTimetableState();
                    applyColorTheme(data.metadata); // Sets the new colours
                    renderAnnouncements(data.announcements);
                    setupSortAndRender(); // Renders the content into the hidden main-container

                    // Immediately show the layout as soon as it's processed
                    document.body.classList.add('theme-ready');
                    document.body.classList.remove('is-loading');
                    document.body.classList.remove('is-switching');

                    setTimeout(() => {
                        const cat = document.getElementById('cat-companion');
                        if (cat) cat.classList.add('visible');

                        const fab = document.getElementById('mobile-fab');
                        if (fab && !fab.classList.contains('nav-hidden')) fab.classList.add('fab-visible');

                    }, 250); // Muted delay to just wait for JS to finish its single-thread work

                    // Prefetch other courses in background for faster switching
                    setTimeout(() => {
                        availableCourses.forEach(c => {
                            if (c !== sheetName && !courseDataCache[c]) fetchCourseData(c);
                        });
                    }, 1000);
                } else {
                    document.body.classList.remove('is-switching');
                }
            });
        }

        function setupSortAndRender() {
            const sortButton = document.getElementById('sort-button');
            if (!sortButton) return;

            // This simplified function now sorts ALL modules by their ID (number)
            const getSortableValue = (module) => {
                if (module.id) {
                    const num = parseInt(module.id, 10);
                    return isNaN(num) ? Infinity : num;
                }
                return Infinity;
            };

            const sortModules = (order) => {
                courseData.modules.sort((a, b) => {
                    const valA = getSortableValue(a);
                    const valB = getSortableValue(b);
                    if (order === 'asc') return valA - valB;
                    else return valB - valA;
                });
            };

            const renderContent = () => {
                const contentDiv = document.getElementById('course-content');
                // If the cat is currently perched (a child of contentDiv), the innerHTML
                // wipe below would destroy that DOM node outright — not just hide it, it's
                // gone for good and getElementById('cat-companion') returns null from then
                // on. Detach it to safety first; positionCatCompanion() re-homes it below.
                const perchedCat = document.getElementById('cat-companion');
                if (perchedCat && perchedCat.parentElement === contentDiv) {
                    document.body.appendChild(perchedCat);
                }
                contentDiv.innerHTML = generateCourseContentHtml(courseData.modules);
                document.querySelectorAll('.module-header').forEach(header => {
                    // toggleModule() already persists the new state synchronously. Don't also
                    // call saveModuleStates() here: on a CLOSE, toggleModule defers the
                    // class removal to a requestAnimationFrame (for the collapse animation),
                    // so a second save reading .classList in the same tick still sees 'active'
                    // and overwrites the just-saved collapsed state back to expanded.
                    header.onclick = () => toggleModule(header.parentNode);
                });
                applyModuleStates();
                setupSearchFilter();
                initializeScrollFaders();
                positionCatCompanion();
            };

            const updateButtonState = (order) => {
                const oldIcon = sortButton.querySelector('i, svg');
                if (oldIcon) {
                    const i = document.createElement('i');
                    i.className = order === 'asc' ? 'fa-solid fa-sort-amount-up' : 'fa-solid fa-sort-amount-down';
                    oldIcon.replaceWith(i);
                }
                sortButton.title = order === 'asc' ? 'Sort Descending' : 'Sort Ascending';
                sortButton.dataset.order = order;
            };

            let sortOrders = JSON.parse(localStorage.getItem('courseSortOrders')) || {};
            let currentOrder = sortOrders[currentCourse] || 'desc';

            sortModules(currentOrder);
            updateButtonState(currentOrder);
            renderContent();

            sortButton.onclick = () => {
                sortButton.classList.remove('rotating');
                void sortButton.offsetWidth;
                sortButton.classList.add('rotating');

                const newOrder = sortButton.dataset.order === 'asc' ? 'desc' : 'asc';
                sortOrders[currentCourse] = newOrder;
                localStorage.setItem('courseSortOrders', JSON.stringify(sortOrders));

                sortModules(newOrder);
                updateButtonState(newOrder);
                renderContent();
            };
        }

        async function fetchCourseData(sheetName, forceRefresh = false) {
            const cacheKeyString = getCachePrefix() + sheetName;

            // Return in-memory cached data if available
            if (!forceRefresh && courseDataCache[cacheKeyString]) {
                return courseDataCache[cacheKeyString];
            }

            // Stale-while-revalidate: show cached data instantly, refresh in background
            // On page reload the in-memory cache is empty, so check sessionStorage
            if (!forceRefresh) {
                try {
                    const cached = sessionStorage.getItem('courseData_' + cacheKeyString);
                    if (cached) {
                        const { data } = JSON.parse(cached);
                        courseDataCache[cacheKeyString] = data;
                        // Return stale data NOW, but revalidate in background
                        revalidateCourseInBackground(sheetName, cacheKeyString);
                        return data;
                    }
                } catch (e) { /* ignore parse errors */ }
            }

            // No cache available — fetch from network (first visit ever)
            try {
                let rows = await fetchPublicSheetData(sheetName, 'A2:J');
                const data = rows.length === 0 ? null : processCourseData(rows);
                if (data) {
                    courseDataCache[cacheKeyString] = data;
                    try { sessionStorage.setItem('courseData_' + cacheKeyString, JSON.stringify({ data })); } catch (e) { }
                }
                return data;
            } catch (error) {
                showImprovedNotification('error', 'Data Error', 'Failed to fetch course data');
                throw error;
            }
        }

        // Background revalidation: fetch fresh data and re-render if it changed
        function revalidateCourseInBackground(sheetName, cacheKeyString) {
            fetchPublicSheetData(sheetName, 'A2:J').then(rows => {
                const freshData = rows.length === 0 ? null : processCourseData(rows);
                if (!freshData) return;

                // Update caches
                courseDataCache[cacheKeyString] = freshData;
                try { sessionStorage.setItem('courseData_' + cacheKeyString, JSON.stringify({ data: freshData })); } catch (e) { }

                // If this is the currently displayed course and data actually changed,
                // silently re-render the UI
                if (sheetName === currentCourse) {
                    const oldJSON = JSON.stringify(courseData);
                    const newJSON = JSON.stringify(freshData);
                    if (oldJSON !== newJSON) {
                        Object.assign(courseData, freshData);
                        window.currentCourseData = freshData; // Expose globally

                        let titleBase = freshData.metadata.code ? `${formatCourseCode(freshData.metadata.code)} ${freshData.metadata.title || 'Course'}` : 'Course Materials';
                        document.title = titleBase;

                        updateCourseMetadata(freshData.metadata);
                        populateActionButtons(freshData.actionButtons, freshData.metadata);
                        applyColorTheme(freshData.metadata, true);
                        renderAnnouncements(freshData.announcements);
                        setupSortAndRender();
                    }
                }
            }).catch(() => { /* silent fail — stale data is still displayed */ });
        }

        function processCourseData(rows) {
            const data = { metadata: {}, modules: [], actionButtons: [], announcements: [] };
            let currentModule = null;

            const getMaterialObject = (r) => ({
                icon: r[1], title: r[2], description: r[3],
                viewLink: r[4], downloadLink: r[5], openLink: r[6],
                fileTypeClass: getFileTypeClass(r[1])
            });

            // Shared helper: parse a module or project row with visibility logic
            const parseModuleRow = (row, type) => {
                const colFValue = String(row[5] || '').toLowerCase().trim();
                if (!colFValue) return null; // Skip if column F is empty
                const defaults = type === 'project'
                    ? { icon: 'fa-solid fa-flask', title: 'Untitled Project' }
                    : { icon: 'fa-solid fa-folder', title: 'Untitled Module' };
                return {
                    type: type === 'project' ? 'project' : 'standard',
                    id: row[1] || Date.now().toString(),
                    order: parseFloat(row[1]) || 0, // shared module/project Order (col b) — see sort below
                    title: row[2] || defaults.title,
                    icon: row[3] || defaults.icon,
                    moduleNumber: row[4] || '',
                    isInitiallyCollapsed: colFValue === 'hide',
                    materials: [], funFacts: [],
                    ...(type === 'project' ? { groups: [] } : {})
                };
            };

            rows.forEach(row => {
                if (!row || row.length === 0) return;
                const type = String(row[0] || '').toLowerCase();

                if (type === 'metadata') {
                    const key = String(row[1] || '').toLowerCase().replace(/\s+/g, '_');
                    if (key) {
                        data.metadata[key] = row[2] || '';
                        if (row[3]) data.metadata[key + '_status'] = row[3];
                    }
                } else if (type === 'button') {
                    data.actionButtons.push({
                        name: row[1] || 'Button',
                        icon: row[2] || 'fa-solid fa-external-link-alt',
                        link: row[3] || '#',
                        colorClass: row[4] || 'btn-primary'
                    });
                } else if (type === 'module' || type === 'project') {
                    const parsed = parseModuleRow(row, type);
                    if (parsed) {
                        currentModule = parsed;
                        data.modules.push(currentModule);
                    } else {
                        currentModule = null; // Reset so materials don't attach to previous module
                    }
                } else if (type === 'announcement') {
                    // Expect format: type, icon, color, time, title, text, actionLink, actionIcons, visibility
                    const iconStr = row[1] || 'fa-solid fa-bullhorn';
                    const colorStr = row[2] || 'var(--warning-color)';
                    const timeStr = row[3] || '';
                    const titleStr = row[4] || '';
                    const textStr = row[5] || '';
                    const actionLinkStr = row[6] || '';
                    const actionIconsStr = row[7] || '';
                    const visibilityStr = String(row[8] || 'HIDE').toUpperCase().trim();

                    if (timeStr || titleStr || textStr) {
                        data.announcements.push({
                            icon: iconStr,
                            color: colorStr,
                            time: timeStr,
                            title: titleStr,
                            text: textStr,
                            actionLink: actionLinkStr,
                            actionIcons: actionIconsStr,
                            visibility: visibilityStr
                        });
                    }
                } else if (type === 'project_description' && currentModule) {
                    currentModule.materials.push({ isDescription: true, text: row[1] || row[2] || '' });
                } else if (type === 'material' && currentModule && currentModule.type === 'standard') {
                    currentModule.materials.push(getMaterialObject(row));
                } else if (type === 'project_file' && currentModule && currentModule.type === 'project') {
                    currentModule.materials.push(getMaterialObject(row));
                } else if (type === 'project_group' && currentModule && currentModule.type === 'project') {
                    const group = { topic: row[1], description: row[2], students: [], files: [] };
                    for (let i = 3; i < row.length; i++) { if (row[i]) group.students.push(row[i]); }
                    if (group.students.length > 0) currentModule.groups.push(group);
                } else if (type === 'group_file' && currentModule?.type === 'project' && currentModule.groups.length > 0) {
                    currentModule.groups[currentModule.groups.length - 1].files.push(getMaterialObject(row));
                } else if (type === 'funfact' && currentModule) {
                    currentModule.funFacts.push({ text: row[1] || '' });
                }
            });

            data.announcements.reverse(); // Show newest announcements first (opposite of backend)

            // Modules and projects share one Order number (col b), set in the admin's Modules view.
            // The rows arrive grouped by row_index (each parent with its content already attached),
            // so sorting by Order here interleaves modules and projects for display without
            // disturbing any parent→content grouping. Highest Order on top (matches the admin);
            // Array.sort is stable, so equal Orders keep their original (row_index) order.
            data.modules.sort((a, b) => b.order - a.order);
            return data;
        }


        function populateActionButtons(buttons, metadata) {
            const container = document.getElementById('course-action-buttons');
            if (!container) return;
            container.innerHTML = '';

            const timetableContainer = document.getElementById('timetable-container');

            let addedAny = false;
            for (let i = 1; i <= 10; i++) {
                const tId = metadata[`timetable${i}_id`] !== undefined ? metadata[`timetable${i}_id`] : (i === 1 ? metadata['timetable_id'] : undefined);
                const cId = metadata[`class${i}_id`] !== undefined ? metadata[`class${i}_id`] : (i === 1 ? metadata['class_id'] : undefined);

                if (tId !== undefined && tId !== '') {
                    const btnName = metadata[`timetable${i}_name`] || 'Timetable';
                    const btnColor = metadata[`timetable${i}_colour`] || 'btn-primary';

                    const timetableBtn = document.createElement('button');
                    timetableBtn.id = `timetable-btn-${i}`;
                    timetableBtn.setAttribute('class', `timetable-btn ${btnColor}`);
                    timetableBtn.innerHTML = `<i class="fa-solid fa-calendar-week"></i> ${btnName}`;
                    timetableBtn.dataset.timetableId = tId;
                    timetableBtn.dataset.classId = cId !== undefined ? cId : '';
                    timetableBtn.dataset.btnName = btnName;
                    timetableBtn.onclick = () => toggleTimetable(i, btnName);
                    container.appendChild(timetableBtn);
                    addedAny = true;
                }
            }

            buttons.forEach(buttonData => {
                const button = document.createElement('button');
                button.setAttribute('class', buttonData.colorClass);
                button.innerHTML = `<i class="${buttonData.icon}"></i> ${buttonData.name}`;
                button.onclick = () => handleActionClick(button, buttonData.link);
                container.appendChild(button);
            });

            // Track wrapped rows for proper CSS edge rounding
            if (!container._resizeObserver) {
                container._resizeObserver = new ResizeObserver(() => updateButtonRows(container));
                container._resizeObserver.observe(container);
            } else {
                updateButtonRows(container); // Force immediate update
            }
        }

        function generateProjectModuleHtml(module) {
            const moduleId = `module-${module.id}`;
            let filesHtml = '';

            if (module.materials.length > 0) {
                const materialCount = module.materials.filter(m => !m.isDescription).length;
                let gridClass = 'materials-grid';
                if (materialCount === 1) gridClass += ' materials-1';
                else if (materialCount === 2) gridClass += ' materials-2';

                let inGrid = false;
                module.materials.forEach(material => {
                    if (material.isDescription) {
                        if (inGrid) { filesHtml += `</div>`; inGrid = false; }
                        filesHtml += `<div class="project-module-description">${material.text}</div>`;
                    } else {
                        if (!inGrid) { filesHtml += `<div class="${gridClass}">`; inGrid = true; }
                        filesHtml += `
            <div class="material-card ${material.fileTypeClass || ''}">
                <div class="material-card-header">
                    <i class="${material.icon || 'fa-regular fa-file-alt'} material-icon"></i>
                    <div class="material-info">
                        <div class="material-title">${material.title}</div>
                        <div class="material-description">${material.description}</div>
                    </div>
                </div>
<div class="material-card-actions">
    ${material.viewLink ? `<button onclick="handleActionClick(this, '${material.viewLink}')" class="btn-blue"><span><i class="fa-regular fa-eye"></i> View</span></button>` : ''}
    ${material.downloadLink ? `<button onclick="handleActionClick(this, '${material.downloadLink}')" class="btn-green"><span><i class="fa-regular fa-save"></i> Download</span></button>` : ''}
    ${material.openLink ? `<button onclick="handleActionClick(this, '${material.openLink}')" class="btn-orange"><span><i class="fa-solid fa-external-link-alt"></i> Open</span></button>` : ''}
</div>
            </div>`;
                    }
                });
                if (inGrid) filesHtml += `</div>`;
            }

            let groupsHtml = '';
            if (module.groups.length > 0) {
                const scrollClass = module.groups.length > 6 ? ' desktop-scrollable is-scrollable' : '';
                groupsHtml += `<div class="project-groups-grid${scrollClass}">`;
                module.groups.forEach(group => {
                    let studentsList = '<ul class="student-list">';
                    group.students.forEach((student, index) => {
                        // If the name is N/A, we skip this entry.
                        // If it's the first entry (index 0), then no one gets the 'leader' underline.
                        if (student.trim().toUpperCase() === 'N/A') return;

                        const className = index === 0 ? 'class="leader"' : '';

                        let displayName = student;
                        const match = student.match(/^(.*?)\s+(R|R\s+EX)$/i);
                        if (match) {
                            displayName = `${match[1]} <span class="student-status-warning">${match[2].toUpperCase()}</span>`;
                        }

                        studentsList += `<li ${className}>${displayName}</li>`;
                    });
                    studentsList += '</ul>';

                    let groupFilesHtml = '';
                    if (group.files && group.files.length > 0) {
                        groupFilesHtml += '<div class="group-files-container">';
                        group.files.forEach(file => {
                            groupFilesHtml += `
                    <div class="group-material-card ${file.fileTypeClass || ''}">
                        <i class="${file.icon || 'fa-regular fa-file-alt'} material-icon"></i>
                        <div class="material-info">
                            <div class="material-title">${file.title}</div>
                            <div class="material-description">${file.description}</div>
                        </div>
                        <div class="material-card-actions">
                             ${file.viewLink ? `<button onclick="handleActionClick(this, '${file.viewLink}')" class="btn-blue"><span><i class="fa-regular fa-eye"></i></span></button>` : ''}
 ${file.downloadLink ? `<button onclick="handleActionClick(this, '${file.downloadLink}')" class="btn-green"><span><i class="fa-regular fa-save"></i></span></button>` : ''}
                        </div>
                    </div>`;
                        });
                        groupFilesHtml += '</div>';
                    }

                    groupsHtml += `
            <div class="project-group-card">
                <div class="project-group-title">${group.topic}</div>
                ${group.description ? `<div class="project-group-description">${group.description}</div>` : ''}
                ${studentsList}
                ${groupFilesHtml}
            </div>`;
                });
                groupsHtml += `</div>`;
            }

            let funFactsHtml = '';
            module.funFacts.forEach(funFact => {
                funFactsHtml += `<div class="fun-fact"><i class="fa-solid fa-lightbulb fun-fact-icon"></i><span class="fun-fact-text">${funFact.text}</span></div>`;
            });

            return `
    <div class="module module-project" id="${moduleId}" data-initially-collapsed="${module.isInitiallyCollapsed === true}">
        <div class="module-header">
            ${module.moduleNumber ? `<span class="module-background-number">${module.moduleNumber}</span>` : ''}
            <span class="module-title"><i class="${module.icon}"></i> ${module.title}</span>
            <i class="fa-solid fa-chevron-down module-toggle-chevron"></i>
        </div>
        <div class="module-content">
            ${filesHtml}
            ${groupsHtml}
            ${funFactsHtml}
        </div>
    </div>`;
        }

        function resetUIElements() {
            const timetableBtns = document.querySelectorAll('.timetable-btn');
            timetableBtns.forEach(btn => {
                const btnName = btn.dataset.btnName || 'Timetable';
                btn.innerHTML = `<i class="fa-solid fa-calendar-week"></i> ${btnName}`;
                btn.classList.remove('active');
            });

            activeTimetableKey = null;
            hideTtPopover();
            const nativeContainer = document.getElementById('native-timetable-container');
            if (nativeContainer) {
                nativeContainer.classList.remove('visible');
            }

            // Hide the entire timetable section completely
            const timetableContainer = document.getElementById('timetable-container');
            if (timetableContainer) {
                timetableContainer.style.display = 'none';
            }

            const announcementBanner = document.getElementById('announcement-banner');
            if (announcementBanner) {
                announcementBanner.style.display = 'none';
                announcementBanner.innerHTML = '';
            }
        }

        function getDismissedAnnouncements() {
            try {
                return JSON.parse(localStorage.getItem('dismissedAnnouncements') || '[]');
            } catch (e) {
                return [];
            }
        }

        function updateAnnouncementCorners() {
            document.querySelectorAll('.announcement-row-group').forEach(group => {
                const rows = Array.from(group.querySelectorAll('.announcement-row:not(.swipe-dismissing)'));

                group.querySelectorAll('.announcement-row').forEach(row => {
                    row.classList.remove('first-in-col', 'last-in-col', 'middle-in-col', 'only-in-col');
                });

                if (rows.length === 1) {
                    rows[0].classList.add('only-in-col');
                } else if (rows.length > 1) {
                    rows.forEach((row, index) => {
                        if (index === 0) row.classList.add('first-in-col');
                        else if (index === rows.length - 1) row.classList.add('last-in-col');
                        else row.classList.add('middle-in-col');
                    });
                }
            });
        }

        function dismissAnnouncement(id, cardElement) {
            const dismissed = getDismissedAnnouncements();
            if (!dismissed.includes(id)) {
                dismissed.push(id);
                localStorage.setItem('dismissedAnnouncements', JSON.stringify(dismissed));
            }

            if (cardElement) {
                // If they passed the inner card instead of the row, find it
                const targetRow = cardElement.classList.contains('announcement-row') ? cardElement : cardElement.closest('.announcement-row');
                if (targetRow) targetRow.classList.add('swipe-dismissing');
                else cardElement.classList.add('swipe-dismissing');

                updateAnnouncementCorners();

                setTimeout(() => {
                    // Force a re-render of announcements from the cached data source
                    if (window.currentCourseData && window.currentCourseData.announcements) {
                        renderAnnouncements(window.currentCourseData.announcements);
                    }
                }, 300); // Wait for transition
            }
        }

        function clearAllAnnouncements() {
            if (window.currentCourseData && window.currentCourseData.announcements) {
                const visibleIds = window.currentCourseData.announcements.map((ann) => btoa(encodeURIComponent(currentCourse + (ann.title || '') + (ann.text || '') + (ann.time || ''))));
                const dismissed = getDismissedAnnouncements();

                visibleIds.forEach(id => {
                    if (!dismissed.includes(id)) {
                        dismissed.push(id);
                    }
                });

                localStorage.setItem('dismissedAnnouncements', JSON.stringify(dismissed));
                renderAnnouncements(window.currentCourseData.announcements);
            }
        }

        function toggleAnnouncements() {
            const collapsedDiv = document.getElementById('announcements-collapsed-view');
            const toggleBtn = document.getElementById('announcements-toggle-btn');

            if (collapsedDiv && toggleBtn) {
                if (collapsedDiv.style.maxHeight && collapsedDiv.style.maxHeight !== '0px') {
                    // Close Action
                    collapsedDiv.style.maxHeight = '0px';
                    collapsedDiv.style.opacity = '0';
                    collapsedDiv.dataset.expanded = 'false';
                    toggleBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i> Show older';

                    // Wait for the CSS transition to finish before hiding it structurally
                    setTimeout(() => {
                        if (collapsedDiv.style.maxHeight === '0px') {
                            collapsedDiv.style.display = 'none';
                        }
                    }, 300); // 0.3s matches the CSS transition time
                } else {
                    // Open Action
                    collapsedDiv.style.display = 'flex'; // Un-hide structurally first

                    // Force a reflow so the browser registers the flex display before applying height
                    void collapsedDiv.offsetHeight;

                    collapsedDiv.style.maxHeight = collapsedDiv.scrollHeight + 'px';
                    collapsedDiv.style.opacity = '1';
                    collapsedDiv.dataset.expanded = 'true';
                    toggleBtn.innerHTML = '<i class="fa-solid fa-chevron-up"></i> Hide older';
                }
            }
        }

        function renderAnnouncements(announcements) {
            const banner = document.getElementById('announcement-banner');
            if (!banner) return;

            // Generate reproducible IDs and filter out dismissed ones
            const dismissedIds = getDismissedAnnouncements();
            const visibleAnnouncements = (announcements || []).map((ann) => {
                const id = btoa(encodeURIComponent(currentCourse + (ann.title || '') + (ann.text || '') + (ann.time || '')));
                return { ...ann, id };
            }).filter(ann => !dismissedIds.includes(ann.id));

            if (visibleAnnouncements.length === 0) {
                banner.style.display = 'none';
                banner.innerHTML = '';
                return;
            }

            let html = '';

            const renderCardHtml = (ann) => {
                let rawColor = (ann.color || '').trim();
                let cssColorVar = 'var(--primary-color)';

                if (rawColor) {
                    if (['primary', 'secondary', 'tertiary', 'accent', 'success', 'warning', 'info', 'danger'].includes(rawColor)) {
                        cssColorVar = `var(--${rawColor}-color)`;
                    } else if (rawColor.startsWith('--')) {
                        cssColorVar = `var(${rawColor})`;
                    } else {
                        cssColorVar = rawColor;
                    }
                }

                let infoHtml = '';
                if (ann.icon) {
                    const profMatch = ann.icon.match(/^professor(\d+)$/i);
                    if (profMatch && window.currentCourseData && window.currentCourseData.metadata) {
                        const profNum = profMatch[1];
                        const photoUrl = window.currentCourseData.metadata[`professor${profNum}_photo`];
                        const profName = window.currentCourseData.metadata[`professor${profNum}`];
                        if (photoUrl) {
                            infoHtml += `<img src="${photoUrl}" alt="Professor" class="announcement-avatar" style="border-color: ${cssColorVar};">`;
                        } else {
                            // Fallback if professor specified but no photo provided
                            infoHtml += `<i class="fa-solid fa-user-circle announcement-icon" style="color: ${cssColorVar};"></i>`;
                        }
                        if (profName) {
                            // Strip common academic titles and prefixes before grabbing the first name
                            const titleRegex = /^(?:assoc\.|prof\.|dr\.|mr\.|ms\.|mrs\.|ing\.|eng\.|prof|dr|mr|ms|mrs|ing|eng)\s+/gi;
                            const cleanName = profName.replace(titleRegex, '').replace(titleRegex, '').trim();
                            const firstName = cleanName.split(' ')[0];
                            infoHtml += `<div class="announcement-prof-name" style="color: ${cssColorVar};">${firstName}</div>`;
                        }
                    } else {
                        infoHtml += `<i class="${ann.icon} announcement-icon" style="color: ${cssColorVar};"></i>`;
                    }
                }

                let timeHtml = '';
                if (ann.time) {
                    timeHtml = `<span class="announcement-date" style="color: ${cssColorVar};">${ann.time}</span>`;
                }

                let actionHtml = '';
                if (ann.actionLink) {
                    const links = ann.actionLink.split(',').map(l => l.trim()).filter(l => l);
                    const icons = (ann.actionIcons || '').split(',').map(i => i.trim());
                    if (links.length > 0) {
                        actionHtml = '<div class="material-card-actions">';
                        links.forEach((link, i) => {
                            const btnBgStyle = ann.color ? `background-color: ${cssColorVar}; border-color: rgba(0,0,0,0.15);` : '';
                            const defaultClass = ann.color ? '' : 'btn-primary';

                            // Explicit classes for future proofing styling fallbacks
                            let posClass = '';
                            if (links.length === 1) posClass = 'only-in-row';
                            else if (i === 0) posClass = 'first-in-row';
                            else if (i === links.length - 1) posClass = 'last-in-row';
                            else posClass = 'middle-in-row';

                            const iconClass = icons[i] || 'fa-solid fa-up-right-from-square';

                            actionHtml += `
                                <button onclick="handleActionClick(this, '${link}')" class="${defaultClass} ${posClass}" style="${btnBgStyle}" title="Open Link">
                                    <i class="${iconClass}" style="margin-right: 0;"></i>
                                </button>`;
                        });
                        actionHtml += '</div>';
                    }
                }
                return `
                    <div class="announcement-row" id="ann-row-${ann.id}">
                        <div class="announcement-card swipeable-announcement" style="--card-accent: ${cssColorVar};">
                            <div class="announcement-icon-wrapper">
                                ${infoHtml}
                            </div>
                            <div class="announcement-content-wrapper">
                                <div class="announcement-header-row">
                                    <div class="announcement-header-info">
                                        ${ann.title ? `<span class="announcement-title" style="color: ${cssColorVar};">${ann.title}</span>` : ''}
                                    </div>
                                    ${timeHtml}
                                </div>
                                <div class="announcement-text">${ann.text}</div>
                            </div>
                        </div>
                        ${actionHtml}
                    </div>
                `;
            };

            // Render highlighted announcements (SHOW) normally
            const initialAnnouncements = visibleAnnouncements.filter(ann => ann.visibility === 'SHOW');
            const collapsedAnnouncements = visibleAnnouncements.filter(ann => ann.visibility !== 'SHOW');

            if (initialAnnouncements.length === 0 && collapsedAnnouncements.length === 0) {
                // If there are no announcements at all, hide everything
                banner.style.display = 'none';
                banner.innerHTML = '';
                return;
            }

            if (initialAnnouncements.length === 0 && collapsedAnnouncements.length > 0) {
                html += `
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 15px; color: #757575; font-size: 0.9em; flex-wrap: wrap;">
                    <span style="user-select: none; -webkit-user-select: none;"><i class="fa-solid fa-bullhorn"></i> There are no new announcements...</span>
                    <button id="announcements-toggle-btn" class="show-more-announcements" onclick="toggleAnnouncements()" style="margin: 0 0 0 auto !important; font-size: 1em;">
                        <i class="fa-solid fa-chevron-down"></i> Show older
                    </button>
                </div>`;
            } else {
                html += `<div id="announcements-active-view" class="announcement-row-group">`;
                initialAnnouncements.forEach(ann => {
                    html += renderCardHtml(ann);
                });
                html += `</div>`;
            }

            // Render the rest in a collapsible container if they exist
            if (collapsedAnnouncements.length > 0) {
                html += `<div id="announcements-collapsed-view" class="announcements-collapsed announcement-row-group" style="max-height: 0px; opacity: 0; display: none;">`;
                collapsedAnnouncements.forEach(ann => {
                    html += renderCardHtml(ann);
                });
                html += `</div>`;

                if (initialAnnouncements.length > 0) {
                    html += `<button id="announcements-toggle-btn" class="show-more-announcements" onclick="toggleAnnouncements()"><i class="fa-solid fa-chevron-down"></i> Show older</button>`;
                }
            }

            // Preserve expanded state before re-rendering
            const existingCollapsedDiv = document.getElementById('announcements-collapsed-view');
            const wasExpanded = existingCollapsedDiv && existingCollapsedDiv.dataset.expanded === 'true';

            banner.innerHTML = html;
            banner.style.display = 'flex';

            updateAnnouncementCorners();

            // Restore expanded state instantly if it was open before dismissal
            if (wasExpanded) {
                const newCollapsedDiv = document.getElementById('announcements-collapsed-view');
                const newToggleBtn = document.getElementById('announcements-toggle-btn');
                if (newCollapsedDiv && newToggleBtn) {
                    newCollapsedDiv.style.display = 'flex';
                    newCollapsedDiv.style.maxHeight = 'none'; // skip animation limitation for instant render
                    newCollapsedDiv.style.opacity = '1';
                    newCollapsedDiv.dataset.expanded = 'true';
                    newToggleBtn.innerHTML = '<i class="fa-solid fa-chevron-up"></i> Hide older';

                    // Small delay then calculate absolute height bounds so future toggles work correctly
                    setTimeout(() => {
                        if (newCollapsedDiv.dataset.expanded === 'true') {
                            newCollapsedDiv.style.maxHeight = newCollapsedDiv.scrollHeight + 'px';
                        }
                    }, 50);
                }
            }

            // Attach touch & mouse swipe listeners universally
            const swipeables = banner.querySelectorAll('.swipeable-announcement');
            swipeables.forEach(card => {
                let startX = 0;
                let currentX = 0;
                let startY = 0;
                let isDragging = false;
                let hasMoved = false;
                let intentLocked = false;   // true once we decide horizontal or vertical
                let isHorizontal = false;   // true = horizontal swipe intent, false = vertical scroll
                const row = card.closest('.announcement-row');
                const annId = row.id.replace('ann-row-', '');

                const getSiblings = () => {
                    const group = row.closest('.announcement-row-group');
                    if (!group) return [];
                    const siblings = [];
                    if (row.previousElementSibling && row.previousElementSibling.classList.contains('announcement-row')) {
                        siblings.push(row.previousElementSibling.querySelector('.announcement-card'));
                    }
                    if (row.nextElementSibling && row.nextElementSibling.classList.contains('announcement-row')) {
                        siblings.push(row.nextElementSibling.querySelector('.announcement-card'));
                    }
                    return siblings.filter(s => s); // remove nulls attached to elements without cards
                };

                const handleStart = (clientX, clientY) => {
                    startX = clientX;
                    startY = clientY;
                    isDragging = true;
                    hasMoved = false;
                    intentLocked = false;
                    isHorizontal = false;
                    card.style.transition = 'none';

                    getSiblings().forEach(sibling => {
                        sibling.style.transition = 'none';
                    });
                };

                const handleMove = (clientX, clientY, e) => {
                    if (!isDragging) return;
                    currentX = clientX;
                    const diffX = currentX - startX;
                    const diffY = clientY - startY;

                    // On first significant move, determine gesture intent
                    if (!intentLocked && (Math.abs(diffX) > 4 || Math.abs(diffY) > 4)) {
                        intentLocked = true;
                        isHorizontal = Math.abs(diffX) >= Math.abs(diffY);
                    }

                    // If intent is vertical (scroll), release control immediately
                    if (intentLocked && !isHorizontal) {
                        isDragging = false;
                        card.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
                        card.style.transform = '';
                        card.style.opacity = '';

                        getSiblings().forEach(sibling => {
                            sibling.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
                            sibling.style.transform = '';
                        });
                        return;
                    }

                    // Require at least 5px of horizontal movement before considering it a drag vs a click
                    if (Math.abs(diffX) > 5) {
                        hasMoved = true;
                        card.classList.add('is-dragging');
                        if (e && e.cancelable) e.preventDefault(); // Prevent scroll while dragging horizontally
                    }

                    if (!hasMoved) return;

                    // Swipe left to dismiss (negative diffX)
                    // Swipe right bounces back (positive diffX)
                    let targetX = diffX;
                    if (diffX < 0) {
                        const triggerThreshold = Math.min(250, window.innerWidth * 0.4);
                        card.style.transform = `translateX(${diffX}px)`;
                        card.style.opacity = Math.max(0, 1 - (Math.abs(diffX) / triggerThreshold));
                    } else if (diffX > 0) {
                        const elasticStretch = (1 - Math.exp(-diffX / 150)) * 100;
                        targetX = elasticStretch;
                        card.style.transform = `translateX(${elasticStretch}px)`;
                    }

                    getSiblings().forEach(sibling => {
                        sibling.style.transform = `translateX(${targetX * 0.04}px)`;
                    });
                };

                const handleEnd = () => {
                    if (!isDragging) return;
                    isDragging = false;
                    card.classList.remove('is-dragging');

                    if (!hasMoved) {
                        // It was just a click, Re-enable smooth transitions and return
                        card.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
                        getSiblings().forEach(sibling => {
                            sibling.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
                        });
                        return;
                    }

                    const diffX = currentX - startX;

                    // Re-enable smooth transitions
                    card.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
                    getSiblings().forEach(sibling => {
                        sibling.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, border-radius 0.3s ease';
                        sibling.style.transform = ''; // swap sibling back immediately
                    });

                    const triggerThreshold = Math.min(250, window.innerWidth * 0.4);

                    if (diffX < -triggerThreshold) { // Swipe left threshold to dismiss
                        dismissAnnouncement(annId, row);
                    } else { // Snap back
                        card.style.transform = '';
                        card.style.opacity = '';
                    }
                    hasMoved = false;
                };

                // Touch Events
                card.addEventListener('touchstart', (e) => handleStart(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
                card.addEventListener('touchmove', (e) => handleMove(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
                card.addEventListener('touchend', handleEnd);
                card.addEventListener('touchcancel', handleEnd);

                // Mouse Events
                const onMouseMove = (e) => handleMove(e.clientX, e.clientY, e);
                const onMouseUp = () => {
                    handleEnd();
                    window.removeEventListener('mousemove', onMouseMove);
                    window.removeEventListener('mouseup', onMouseUp);
                };

                card.addEventListener('mousedown', (e) => {
                    if (e.target.closest('button') || e.target.closest('a')) return;
                    handleStart(e.clientX, e.clientY);
                    window.addEventListener('mousemove', onMouseMove);
                    window.addEventListener('mouseup', onMouseUp);
                });
            });
        }

        function handleActionClick(btn, link) {
            // Prevent event from bubbling up to the card if needed, though they are siblings here
            window.open(link, '_blank', 'noopener,noreferrer');
        }

        function updateCourseMetadata(metadata) {
            document.getElementById('course-code').textContent = metadata.code ? formatCourseCode(metadata.code) : 'Course Code';

            const profContainer = document.getElementById('professors-container');
            if (profContainer) {
                profContainer.innerHTML = '';
                let professors = [];

                for (let i = 1; i <= 5; i++) {
                    if (metadata[`professor${i}`]) {
                        professors.push({
                            name: metadata[`professor${i}`],
                            photo: metadata[`professor${i}_photo`] || null,
                            link: metadata[`professor${i}_link`] || null
                        });
                    }
                }

                if (professors.length > 0) {
                    professors.forEach(prof => {
                        const item = document.createElement('span');
                        item.setAttribute('class', 'info-item professor-item');

                        let content = '';
                        if (prof.photo) {
                            content = `<img src="${prof.photo}" alt="${prof.name}" class="professor-photo" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block';">`;
                            content += `<i class="fa-solid fa-user-circle" style="display:none;"></i>`;
                        } else {
                            content = '<i class="fa-solid fa-user-circle"></i>';
                        }
                        content += ` ${prof.name}`;

                        if (prof.link) {
                            item.innerHTML = `<a href="${prof.link}" target="_blank" rel="noopener noreferrer" class="professor-link">${content}</a>`;
                        } else {
                            item.innerHTML = content;
                        }

                        profContainer.appendChild(item);
                    });
                } else {
                    const item = document.createElement('span');
                    item.setAttribute('class', 'info-item');
                    item.innerHTML = '<i class="fa-solid fa-user-circle"></i> Instructor';
                    profContainer.appendChild(item);
                }

            }

            document.getElementById('course-title').textContent = metadata.title || 'Course Title';
            // Archived courses show their academic year alongside the semester (e.g. "Fall Semester 2023-2024"),
            // since without the active/current-year context, the semester alone is ambiguous for a past offering.
            const semesterText = metadata.semester || 'Unknown Semester';
            document.getElementById('course-semester').textContent = (isArchiveMode && metadata.year) ? `${semesterText} ${metadata.year}` : semesterText;
            document.getElementById('course-level').textContent = metadata.level || 'Undergraduate';
            const creditsContainer = document.getElementById('course-credits-container');
            if (metadata.credits) {
                document.getElementById('course-credits').textContent = metadata.credits + ' ECTS';
                if (creditsContainer) creditsContainer.style.display = '';
            } else if (creditsContainer) {
                creditsContainer.style.display = 'none';
            }

            const courseType = metadata.type || 'Compulsory';
            document.getElementById('course-type').textContent = courseType;
            const typeContainer = document.getElementById('course-type-container');
            if (typeContainer) {
                typeContainer.innerHTML = courseType.toLowerCase() === 'elective' ? '<i class="fa-regular fa-circle"></i> <span id="course-type">Elective</span>' : '<i class="fa-solid fa-exclamation-circle"></i> <span id="course-type">Compulsory</span>';
            }
            // Archived courses are already finished, so the "current week" counter and term
            // progress bar don't mean anything for them — hide both entirely.
            const weekInfoItem = document.getElementById('week-info-item');
            const progressBarContainer = document.getElementById('progress-bar-container');
            if (isArchiveMode) {
                if (weekInfoItem) weekInfoItem.style.display = 'none';
                if (progressBarContainer) progressBarContainer.style.display = 'none';
            } else {
                if (weekInfoItem) weekInfoItem.style.display = '';
                if (progressBarContainer) progressBarContainer.style.display = '';
                const hStart = metadata.holiday_startdate || metadata.holiday_start_date || metadata.holidaystartdate || metadata.holiday_start;
                updateWeekProgress(metadata.startdate, metadata.enddate, metadata.holidayweeks, hStart);
            }

            const evaluationDisplay = document.getElementById('evaluation-display');
            if (hasEvaluationData(metadata)) {
                evaluationDisplay.style.display = 'block';
                generateGradeDistribution(metadata);
            } else {
                evaluationDisplay.style.display = 'none';
            }

            // Update info-item row classes after all items have been populated
            // Defer slightly so the browser has laid out the row before we measure offsetTop
            requestAnimationFrame(() => updateInfoItemRows());

            // Reinstall a ResizeObserver on course-info so rows re-compute if the chip set reflows
            const courseInfoEl = document.getElementById('course-info');
            if (courseInfoEl && !courseInfoEl._infoRowObserver) {
                courseInfoEl._infoRowObserver = new ResizeObserver(() => updateInfoItemRows());
                courseInfoEl._infoRowObserver.observe(courseInfoEl);
            }
        }

        function generateCourseContentHtml(modules) {
            const sideNav = document.getElementById('side-nav-container');
            const sideNavToggle = document.getElementById('side-nav-toggle');
            const mobileFab = document.getElementById('mobile-fab');
            const mobileMenu = document.getElementById('mobile-fab-menu');
            const sortButton = document.getElementById('sort-button');
            const searchBar = document.getElementById('search-bar');
            const searchContainer = searchBar ? searchBar.parentElement : null;

            // --- NEW LOGIC: Check the number of modules ---
            const moduleCount = modules ? modules.length : 0;

            if (moduleCount <= 1) {
                // --- Case 1: 0 or 1 module ---
                // Hide navigation
                if (sideNav) sideNav.style.display = 'none';
                if (sideNavToggle) sideNavToggle.style.display = 'none';
                if (mobileFab) { mobileFab.classList.remove('fab-visible'); mobileFab.classList.add('nav-hidden'); }

                // Disable search and sort
                if (sortButton) {
                    sortButton.disabled = true;
                    sortButton.classList.add('disabled-look');
                }
                if (searchBar) searchBar.disabled = true;
                if (searchContainer) searchContainer.classList.add('disabled-look');

            } else {
                // --- Case 2: More than 1 module ---
                // Show navigation (resetting style to let CSS media queries take over)
                if (sideNav) sideNav.style.display = '';
                if (sideNavToggle) sideNavToggle.style.display = '';
                if (mobileFab) { mobileFab.classList.remove('nav-hidden'); }

                // Enable search and sort
                if (sortButton) {
                    sortButton.disabled = false;
                    sortButton.classList.remove('disabled-look');
                }
                if (searchBar) searchBar.disabled = false;
                if (searchContainer) searchContainer.classList.remove('disabled-look');
            }

            // Clear previous items
            sideNav.querySelectorAll('.side-nav-item').forEach(item => item.remove());
            if (mobileMenu) mobileMenu.innerHTML = '';

            if (!modules || modules.length === 0) {
                return '<div class="empty-content"><i class="fa-solid fa-box-open"></i><br>No modules have been added to this course yet.</div>';
            }

            const handleNavClick = (e) => {
                e.preventDefault();
                isProgrammaticScroll = true;

                sideNav.querySelectorAll('.side-nav-item').forEach(link => link.classList.remove('active'));
                e.currentTarget.classList.add('active');

                const targetId = e.currentTarget.getAttribute('href');
                const targetElement = document.querySelector(targetId);

                if (targetElement) {
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    if (history.pushState) { history.pushState(null, null, targetId); }
                    else { location.hash = targetId; }
                }

                setTimeout(() => { isProgrammaticScroll = false; }, 1000);
            };

            let html = '';
            modules.forEach(module => {
                const moduleId = `#module-${module.id}`;

                const navItem = document.createElement('a');
                navItem.setAttribute('class', 'side-nav-item');
                navItem.href = moduleId;
                navItem.innerHTML = `<i class="${module.icon}"></i> <span>${module.title}</span>`;
                navItem.addEventListener('click', handleNavClick);
                sideNav.appendChild(navItem);

                if (mobileMenu) {
                    const mobileNavItem = document.createElement('a');
                    mobileNavItem.setAttribute('class', 'mobile-fab-menu-item');
                    mobileNavItem.href = moduleId;
                    mobileNavItem.innerHTML = `${module.title} <i class="${module.icon}"></i>`;
                    mobileNavItem.addEventListener('click', (e) => {
                        handleNavClick(e);
                        document.getElementById('mobile-fab')?.click();
                    });
                    mobileMenu.appendChild(mobileNavItem);
                }

                if (module.type === 'project') {
                    html += generateProjectModuleHtml(module);
                } else {
                    const materialCount = module.materials.filter(m => !m.isDescription).length;
                    let gridClass = 'materials-grid';
                    if (materialCount === 1) gridClass += ' materials-1';
                    else if (materialCount === 2) gridClass += ' materials-2';

                    html += `
            <div class="module" id="module-${module.id}" data-initially-collapsed="${module.isInitiallyCollapsed === true}">
                <div class="module-header">
                    ${module.moduleNumber ? `<span class="module-background-number">${module.moduleNumber}</span>` : ''}
                    <span class="module-title"><i class="${module.icon}"></i> ${module.title}</span>
                    <i class="fa-solid fa-chevron-down module-toggle-chevron"></i>
                </div>
                <div class="module-content">`;

                    let inGrid = false;
                    module.materials.forEach(material => {
                        if (material.isDescription) {
                            if (inGrid) { html += `</div>`; inGrid = false; }
                            html += `<div class="project-module-description">${material.text}</div>`;
                        } else {
                            if (!inGrid) { html += `<div class="${gridClass}">`; inGrid = true; }
                            html += `
                    <div class="material-card ${material.fileTypeClass || ''}">
                        <div class="material-card-header">
                            <i class="${material.icon} material-icon"></i>
                            <div class="material-info">
                                <div class="material-title">${material.title}</div>
                                <div class="material-description">${material.description}</div>
                            </div>
                        </div>
                        <div class="material-card-actions">
                            ${material.viewLink ? `<button onclick="handleActionClick(this, '${material.viewLink}')" class="btn-blue"><span><i class="fa-regular fa-eye"></i> View</span></button>` : ''}
${material.downloadLink ? `<button onclick="handleActionClick(this, '${material.downloadLink}')" class="btn-green"><span><i class="fa-regular fa-save"></i> Download</span></button>` : ''}
${material.openLink ? `<button onclick="handleActionClick(this, '${material.openLink}')" class="btn-orange"><span><i class="fa-solid fa-external-link-alt"></i> Open</span></button>` : ''}
                        </div>
                    </div>`;
                        }
                    });
                    if (inGrid) { html += `</div>`; }
                    module.funFacts.forEach(funFact => {
                        html += `<div class="fun-fact"><i class="fa-solid fa-lightbulb fun-fact-icon"></i><span class="fun-fact-text">${funFact.text}</span></div>`;
                    });
                    html += `</div></div>`;
                }
            });
            return html;
        }

        function updateActiveNavLink() {
            if (isProgrammaticScroll) return; // This is the new line that prevents flickering

            let activeModuleId = '';
            const modules = document.querySelectorAll('.module');
            const navLinks = document.querySelectorAll('.side-nav-item');
            const offset = window.innerHeight / 2; // Corrected offset
            modules.forEach(module => {
                const rect = module.getBoundingClientRect();
                if (rect.top <= offset && rect.bottom >= offset) {
                    activeModuleId = module.id;
                }
            });
            navLinks.forEach(link => {
                link.classList.toggle('active', link.getAttribute('href') === `#${activeModuleId}`);
            });
        }

        function calculateWeek(startDate, endDate, holidayWeeks = 0, holidayStart = null) {
            const start = new Date(startDate);
            const end = new Date(endDate);
            const today = new Date();
            const oneWeek = 7 * 24 * 60 * 60 * 1000;

            const totalWeeks = Math.ceil((end - start) / oneWeek) - (parseInt(holidayWeeks || 0));
            const rawWeek = Math.ceil((today - start) / oneWeek);

            if (rawWeek < 1) return 1;

            let adjustedWeek = rawWeek;

            if (holidayStart && holidayWeeks > 0) {
                const hStart = new Date(holidayStart);
                const holidayStartWeek = Math.ceil((hStart - start) / oneWeek);

                if (rawWeek >= holidayStartWeek) {
                    if (rawWeek < holidayStartWeek + parseInt(holidayWeeks)) {
                        // In holiday period: return last active week
                        return Math.max(1, holidayStartWeek - 1);
                    } else {
                        // Past holiday: subtract duration
                        adjustedWeek = rawWeek - parseInt(holidayWeeks);
                    }
                }
            } else {
                if (parseInt(holidayWeeks || 0) > 0) {
                    adjustedWeek = rawWeek - parseInt(holidayWeeks || 0);
                }
            }

            return Math.min(Math.max(adjustedWeek, 1), totalWeeks);
        }

        function updateWeekProgress(startDate = "2025-02-24", endDate = "2025-06-14", holidayWeeks = 0, holidayStart = null) {
            const weekCounter = document.getElementById('week-counter');
            weekCounter.textContent = `Week ${calculateWeek(startDate, endDate, holidayWeeks, holidayStart)}`;
            const start = new Date(startDate);
            const end = new Date(endDate);
            const today = new Date();
            const totalDuration = end - start;
            const elapsedDuration = today - start;
            let progressPercentage = Math.min(Math.max((elapsedDuration / totalDuration) * 100, 0), 100);
            document.getElementById('progress-bar').style.width = progressPercentage + '%';
        }

        // Grading categories, in display order. Mirrors GRADING_CATEGORIES in teaching/admin/index.html.
        // `legacyKey` keeps reading older single, un-numbered keys (e.g. courses saved before this
        // category supported multiple entries) so older saved data still renders correctly here even
        // if the admin panel hasn't been re-saved since.
        const GRADING_CATEGORIES = [
            { id: 'hw', singular: 'Homework', plural: 'Homeworks' },
            { id: 'project', singular: 'Project', plural: 'Projects', legacyKey: 'term_project_percentage' },
            { id: 'casestudy', singular: 'Case Study', plural: 'Case Studies' },
            { id: 'lab', singular: 'Laboratory', plural: 'Laboratories' },
            { id: 'quiz', singular: 'Quiz', plural: 'Quizzes' },
            { id: 'midterm', singular: 'Midterm', plural: 'Midterms', legacyKey: 'midterm_percentage' },
            { id: 'final', singular: 'Final', plural: 'Final', fixed: true, key: 'final_percentage' },
            { id: 'attendance', singular: 'Attendance', plural: 'Attendance', fixed: true, key: 'attendance_percentage' },
            { id: 'other', singular: 'Other', plural: 'Other' },
        ];

        // Existing numbered + legacy entries for a category, e.g. quiz1_percentage, quiz2_percentage.
        function gradingItemsFor(cat, metadata) {
            if (cat.fixed) return [{ key: cat.key }];
            const re = new RegExp(`^${cat.id}(\\d+)_percentage$`);
            const nums = [];
            for (const k of Object.keys(metadata)) {
                const m = k.match(re);
                if (m) nums.push(parseInt(m[1], 10));
            }
            nums.sort((a, b) => a - b);
            const items = nums.map(n => ({ key: `${cat.id}${n}_percentage` }));
            if (cat.legacyKey && metadata[cat.legacyKey]) items.push({ key: cat.legacyKey });
            return items;
        }

        function hasEvaluationData(metadata) {
            return GRADING_CATEGORIES.some(cat =>
                gradingItemsFor(cat, metadata).some(item => parseFloat(metadata[item.key]) > 0)
            );
        }


        function generateGradeDistribution(metadata) {
            const bar = document.getElementById('distribution-bar');
            const legend = document.getElementById('distribution-legend');
            bar.innerHTML = '';
            legend.innerHTML = '';

            const colorSets = {
                hw: ['rgba(255,255,255,0.22)', 'rgba(255,255,255,0.19)', 'rgba(255,255,255,0.16)', 'rgba(255,255,255,0.13)'],
                project: ['rgba(255,255,255,0.38)', 'rgba(255,255,255,0.35)', 'rgba(255,255,255,0.32)'],
                casestudy: ['rgba(255,255,255,0.44)', 'rgba(255,255,255,0.41)'],
                lab: ['rgba(255,255,255,0.50)', 'rgba(255,255,255,0.47)'],
                quiz: ['rgba(255,255,255,0.30)', 'rgba(255,255,255,0.27)', 'rgba(255,255,255,0.24)', 'rgba(255,255,255,0.21)'],
                midterm: ['rgba(255,255,255,0.42)', 'rgba(255,255,255,0.39)'],
                final: ['rgba(255,255,255,0.48)'],
                attendance: ['rgba(255,255,255,0.15)'],
                other: ['rgba(255,255,255,0.20)', 'rgba(255,255,255,0.17)'],
            };
            const legendColors = {
                hw: 'rgba(255,255,255,0.6)', project: 'rgba(255,255,255,0.7)', casestudy: 'rgba(255,255,255,0.66)',
                lab: 'rgba(255,255,255,0.72)', quiz: 'rgba(255,255,255,0.65)', midterm: 'rgba(255,255,255,0.75)',
                final: 'rgba(255,255,255,0.8)', attendance: 'rgba(255,255,255,0.55)', other: 'rgba(255,255,255,0.58)',
            };

            GRADING_CATEGORIES.forEach(cat => {
                const colors = colorSets[cat.id] || ['rgba(255,255,255,0.3)'];
                let totalPercentage = 0;
                let nonZeroCount = 0;
                let colorIndex = 0;
                gradingItemsFor(cat, metadata).forEach(item => {
                    const percentage = parseFloat(metadata[item.key]) || 0;
                    if (percentage > 0) {
                        const segment = document.createElement('div');
                        segment.setAttribute('class', 'distribution-segment');
                        segment.style.width = `${percentage}%`;

                        const statusKey = item.key + '_status';
                        const isDone = (metadata[statusKey] || '').trim().toUpperCase() === 'DONE';
                        segment.style.backgroundColor = isDone ? 'var(--success-color)' : colors[colorIndex % colors.length];

                        const display = percentage % 1 === 0 ? percentage.toFixed(0) : percentage + '';
                        segment.innerHTML = `<div class="segment-percentage">${display}%</div>`;
                        bar.appendChild(segment);
                        totalPercentage += percentage;
                        nonZeroCount++;
                        colorIndex++;
                    }
                });

                if (totalPercentage > 0) {
                    const legendItem = document.createElement('div');
                    legendItem.setAttribute('class', 'legend-item');
                    legendItem.style.width = `${totalPercentage}%`;
                    legendItem.textContent = nonZeroCount > 1 ? cat.plural : cat.singular;
                    legendItem.style.color = legendColors[cat.id] || colors[0];
                    legend.appendChild(legendItem);
                }
            });
        }

        function updateYear() {
            const yearEl = document.getElementById('currentYear');
            if (yearEl) yearEl.textContent = new Date().getFullYear();
        }

        // Fills the footer's owner-specific bits (and favicon) from config.js so the
        // markup itself stays identical across deployments (only config.js differs).
        function applyOwnerBranding() {
            const owner = (window.TEACHING_CONFIG && window.TEACHING_CONFIG.owner) || {};
            const cv = document.getElementById('footer-cv');
            if (cv && owner.cvUrl) cv.href = owner.cvUrl;
            const email = document.getElementById('footer-email');
            if (email && owner.email) email.href = `mailto:${owner.email}`;
            const name = document.getElementById('footer-owner');
            if (name && owner.name) name.textContent = owner.name;
            const startYear = document.getElementById('footer-start-year');
            if (startYear && owner.startYear) startYear.textContent = owner.startYear;
            const home = document.getElementById('footer-home');
            if (home && owner.homeUrl) home.href = owner.homeUrl;
            const favicon = document.querySelector('link[rel="icon"]');
            if (favicon && owner.faviconUrl) favicon.href = owner.faviconUrl;
        }

        // Applies the default colour palette from config.js as CSS custom properties.
        // Runs before any per-course theming, so a course's own colours still override.
        function applyThemeDefaults() {
            const t = (window.TEACHING_CONFIG && window.TEACHING_CONFIG.theme) || {};
            const root = document.documentElement.style;
            const map = {
                '--primary-color': t.primary,
                '--primary-dark': t.primaryDark,
                '--secondary-color': t.secondary,
                '--tertiary-color': t.tertiary,
                '--accent-color': t.accent,
                '--success-color': t.success,
            };
            Object.entries(map).forEach(([prop, val]) => { if (val) root.setProperty(prop, val); });
        }

        function showImprovedNotification(type, title, message, duration) {
            if (type === 'success' && title === 'Course Loaded') return;
            if (isInitializing || criticalErrorsOnly) {
                if (!(type === 'error' && (title.includes('Critical') || message.includes('Permission denied')))) {
                    pendingNotifications.push({ type, title, message, duration });
                    return;
                }
            }
            const safeRemove = (el) => {
                if (el && el.parentNode) el.parentNode.removeChild(el);
            };
            const area = document.getElementById('notification-area');
            if (!area) return;
            area.querySelectorAll(`.in-page-notification-${type}`).forEach(n => {
                n.classList.add('removing');
                setTimeout(() => safeRemove(n), 300);
            });
            const allNotifs = area.querySelectorAll('.in-page-notification');
            if (allNotifs.length >= 2) {
                const oldest = allNotifs[0];
                oldest.classList.add('removing');
                setTimeout(() => safeRemove(oldest), 300);
            }
            const notification = document.createElement('div');
            notification.setAttribute('class', `in-page-notification in-page-notification-${type}`);
            let icon = 'info-circle';
            if (type === 'success') icon = 'check-circle';
            if (type === 'error') icon = 'times-circle';
            if (type === 'warning') icon = 'exclamation-circle';
            notification.innerHTML = `<i class="fa-solid fa-${icon}"></i><div style="flex-grow:1;"><strong>${title}</strong><br>${message}</div><button class="notification-close">&times;</button>`;
            area.appendChild(notification);
            notification.querySelector('.notification-close').onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                notification.classList.add('removing');
                setTimeout(() => safeRemove(notification), 300);
            };
            if (type !== 'error') {
                setTimeout(() => {
                    notification.classList.add('removing');
                    setTimeout(() => safeRemove(notification), 300);
                }, duration || 5000);
            }
        }

        function processPendingNotifications() {
            if (pendingNotifications.length > 0) {
                const unique = {};
                for (const n of pendingNotifications) {
                    unique[n.type + n.title] = n;
                }
                Object.values(unique).forEach(n => showImprovedNotification(n.type, n.title, n.message, n.duration));
                pendingNotifications = [];
            }
        }

        document.addEventListener('DOMContentLoaded', init);
