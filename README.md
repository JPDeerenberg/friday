# Friday

Friday is a high-performance, cross-platform agenda and school management application built with Tauri v2 and SvelteKit. Designed to be lightweight and fast, it provides a seamless interface for managing academic schedules, assignments, and school data.

🚀 Key Features
 * Multi-Platform Support: Native builds for Windows (.exe), Linux (.deb/AppImage), and Android (.apk).
 * Comprehensive Academic Tools: Modular commands for managing activities, assignments, grades, messages, and more.
 * Modern Tech Stack: Uses Svelte 5 and Tailwind CSS for a responsive, fluid frontend.
 * Deep Link Integration: Supports custom URI schemes (m6loapp://) for authentication and external redirects.

## 🛠 Tech Stack
 * Frontend: SvelteKit, Vite, Tailwind CSS.
 * Backend: Rust (Tauri v2).
 * Package Manager: pnpm.

## 📦 Building from Source
Prerequisites
 * Node.js (v20 or higher)
 * Rust Toolchain (Stable)
 * pnpm (v9+)
 * Android SDK & JDK 17 (For Android builds)
Installation
 * Clone the repository:
   git clone https://github.com/jpdeerenberg/agenda-tauri.git
cd agenda-tauri

 * Install dependencies:
   pnpm install

Development
Run the application in development mode:
pnpm tauri dev

Production Build
 * Desktop: pnpm tauri build
 * Android: pnpm tauri android build --apk

## 🛡 License
This project is licensed under the MIT License.