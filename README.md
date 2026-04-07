<p align="center">
  <img src="newlogo.png" width="180" alt="Friday Logo">
</p>

# Friday

Friday is a high-performance, cross-platform agenda and school management application built with **Tauri v2** and **Svelte 5**. Designed specifically for students, it provides a seamless and lightweight experience for managing academic schedules, assignments, and grades.

[![Tauri](https://img.shields.io/badge/Tauri-v2-blue?logo=tauri)](https://tauri.app/)
[![Svelte](https://img.shields.io/badge/Svelte-v5-FF3E00?logo=svelte)](https://svelte.dev/)
[![Tailwind](https://img.shields.io/badge/Tailwind-v4-38B2AC?logo=tailwind-css)](https://tailwindcss.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🚀 Key Features

*   **⚡ Native Performance:** Lightning-fast experience on all platforms thanks to the Rust backend.
*   **📱 Multi-Platform Support:** Native builds for **Windows** (.exe), **Linux** (.deb/AppImage), and **Android** (.apk).
*   **📚 Academic Hub:** Comprehensive tools for managing activities, assignments, grades, and messages.
*   **🎨 Modern UI:** Fluid, responsive interface built with **Svelte 5** and **Tailwind CSS**.
*   **🔗 Deep Link Integration:** Seamless authentication and redirects via custom URI schemes (`m6loapp://`).

---

## 🛠 Tech Stack

- **Frontend:** [SvelteKit](https://kit.svelte.dev/) (Svelte 5), [Vite](https://vitejs.dev/), [Tailwind CSS 4](https://tailwindcss.com/)
- **Backend:** [Rust](https://www.rust-lang.org/) ([Tauri v2](https://v2.tauri.app/))
- **Package Manager:** [pnpm](https://pnpm.io/)

---

## 📦 Getting Started

### Prerequisites

Ensure you have the following installed:
- **Node.js** (v20+) & **pnpm** (v9+)
- **Rust Toolchain** (Stable)
- **Android SDK & JDK 17** (For Android builds)

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/jpdeerenberg/agenda-tauri.git
    cd agenda-tauri
    ```

2.  **Install dependencies:**
    ```bash
    pnpm install
    ```

### Development

Run the application in development mode:
```bash
pnpm tauri dev
```

### Building for Production

-   **Desktop:** `pnpm tauri build`
-   **Android:** `pnpm tauri android build --apk`

---

## 🎓 Acknowledgements

This project wouldn't be possible without the inspiration and foundational work from other open-source projects.

Special thanks to **[Discipulus](https://github.com/DiscipulusApp/Discipulus)** for its impressive alternative Magister client, which served as a significant inspiration for Friday's development and logic.

---

## 🛡 License

This project is licensed under the **MIT License**. See the [LICENSE](license) file for details.