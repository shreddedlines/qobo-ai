import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { AuthProvider } from "../auth/AuthProvider.tsx";
import { ThemeProvider } from "../theme/ThemeProvider.tsx";
import { RedirectIfSignedIn, RequireAuth } from "../auth/RouteGuard.tsx";
import { AppShell } from "./AppShell.tsx";
import { ChatLayout } from "./ChatLayout.tsx";
import { AuthPage } from "./routes/AuthPage.tsx";
import { ChatPage } from "./routes/ChatPage.tsx";
import { NotFoundPage } from "./routes/NotFoundPage.tsx";

export function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <AppShell>
            <Routes>
              <Route path="/" element={<Navigate to="/chat" replace />} />
              {/* Both chat routes share the history sidebar, so it is not reloaded when
                switching conversations. */}
              <Route
                element={
                  <RequireAuth>
                    <ChatLayout />
                  </RequireAuth>
                }
              >
                <Route path="/chat" element={<ChatPage />} />
                <Route path="/chat/:conversationId" element={<ChatPage />} />
              </Route>
              <Route
                path="/login"
                element={
                  <RedirectIfSignedIn>
                    <AuthPage mode="signin" />
                  </RedirectIfSignedIn>
                }
              />
              <Route
                path="/signup"
                element={
                  <RedirectIfSignedIn>
                    <AuthPage mode="signup" />
                  </RedirectIfSignedIn>
                }
              />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </AppShell>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
