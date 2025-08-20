import React, { useState, useEffect } from 'react';

const TelegramAuth = ({ onAuthSuccess, onAuthFailure }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [authUrl, setAuthUrl] = useState('');

  useEffect(() => {
    // Generate Telegram auth URL
    const botToken = process.env.REACT_APP_TELEGRAM_BOT_TOKEN;
    const domain = 'api-wallet-monitor.duckdns.org';
    const redirectUrl = `${window.location.origin}/auth/telegram/callback`;
    
    if (botToken) {
      setAuthUrl(`https://oauth.telegram.org/auth?bot_id=${botToken}&origin=${domain}&request_access=write&return_to=${encodeURIComponent(redirectUrl)}`);
    }
  }, []);

  const handleTelegramAuth = async (telegramData) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(telegramData),
      });

      const result = await response.json();

      if (result.success) {
        // Store auth token
        localStorage.setItem('authToken', result.token);
        localStorage.setItem('userData', JSON.stringify(result.user));
        onAuthSuccess(result.user, result.token);
      } else {
        setError(result.message || 'Authentication failed');
        onAuthFailure(result.message);
      }
    } catch (error) {
      console.error('Auth error:', error);
      setError('Network error during authentication');
      onAuthFailure('Network error');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle callback from Telegram
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const hash = window.location.hash.substring(1);
    const hashParams = new URLSearchParams(hash);
    
    // Parse Telegram auth data
    const telegramData = {};
    ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash'].forEach(key => {
      const value = urlParams.get(key) || hashParams.get(key);
      if (value) telegramData[key] = value;
    });

    if (telegramData.id && telegramData.hash) {
      handleTelegramAuth(telegramData);
    }
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-blue-800 to-indigo-900 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">WalletPulse</h1>
          <p className="text-gray-600">Secure Solana Wallet Monitor</p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <div className="flex items-center">
              <svg className="w-5 h-5 text-red-500 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd"/>
              </svg>
              <span className="text-red-700 text-sm">{error}</span>
            </div>
          </div>
        )}

        <div className="space-y-6">
          <div className="text-center">
            <h2 className="text-xl font-semibold text-gray-800 mb-4">
              Sign in with Telegram
            </h2>
            <p className="text-sm text-gray-600 mb-6">
              Secure authentication through your Telegram account
            </p>
          </div>

          {authUrl ? (
            <a
              href={authUrl}
              className={`w-full bg-blue-500 hover:bg-blue-600 text-white font-medium py-3 px-4 rounded-lg transition-colors flex items-center justify-center space-x-2 ${
                isLoading ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              onClick={(e) => {
                if (isLoading) e.preventDefault();
              }}
            >
              {isLoading ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                  <span>Authenticating...</span>
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.568 8.16c-.169 1.858-.896 6.728-.896 6.728-.377 2.655-1.407 3.119-2.896 1.928-.926-.74-1.474-1.38-2.38-2.233-.59-.555-.102-1.207.255-1.544.949-.897 2.083-1.946 2.775-2.617.37-.359.194-.578-.238-.345-1.095.589-2.784 1.876-3.992 2.656-.874.563-1.764.818-3.017.364-1.316-.476-2.835-1.02-2.835-1.02s-1.036-.653.731-1.347c4.612-1.839 10.29-4.098 15.582-6.049 1.998-.743 1.911 1.497 1.911 1.497z"/>
                  </svg>
                  <span>Continue with Telegram</span>
                </>
              )}
            </a>
          ) : (
            <div className="text-center text-gray-500">
              <p className="text-sm">Configuration error. Please contact administrator.</p>
            </div>
          )}

          <div className="text-center">
            <p className="text-xs text-gray-500">
              Only whitelisted users can access this application.
              <br />
              Contact your administrator if you need access.
            </p>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-gray-200">
          <div className="flex items-center justify-center text-xs text-gray-500">
            <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd"/>
            </svg>
            <span>Secure & Private</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TelegramAuth;