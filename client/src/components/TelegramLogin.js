import React, { useState, useEffect } from 'react';

const TelegramLogin = ({ onLogin, botUsername }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Load Telegram widget script
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    
    script.onload = () => {
      console.log('Telegram widget script loaded');
    };
    
    document.head.appendChild(script);

    // Global callback function for Telegram widget
    window.onTelegramAuth = async (user) => {
      setIsLoading(true);
      setError(null);
      
      try {
        console.log('Telegram auth data received:', user);
        
        const response = await fetch('/api/auth/telegram', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(user),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Authentication failed');
        }

        // Store session token
        localStorage.setItem('sessionToken', data.sessionToken);
        localStorage.setItem('user', JSON.stringify(data.user));
        
        onLogin(data);
      } catch (error) {
        console.error('Login error:', error);
        setError(error.message);
      } finally {
        setIsLoading(false);
      }
    };

    return () => {
      // Cleanup
      const scripts = document.querySelectorAll('script[src*="telegram-widget"]');
      scripts.forEach(script => script.remove());
      delete window.onTelegramAuth;
    };
  }, [onLogin]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">WalletPulse</h1>
          <p className="text-gray-600">Solana Wallet Monitor</p>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-center">
              <svg className="w-5 h-5 text-red-500 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              <span className="text-red-700 text-sm">{error}</span>
            </div>
          </div>
        )}

        <div className="space-y-6">
          <div className="text-center">
            <h2 className="text-xl font-semibold text-gray-800 mb-2">
              Login with Telegram
            </h2>
            <p className="text-gray-600 text-sm mb-6">
              Secure authentication through your Telegram account
            </p>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <span className="ml-3 text-gray-600">Authenticating...</span>
            </div>
          ) : (
            <div className="flex justify-center">
              <script
                async
                src="https://telegram.org/js/telegram-widget.js?22"
                data-telegram-login={botUsername}
                data-size="large"
                data-onauth="onTelegramAuth(user)"
                data-request-access="write"
              ></script>
            </div>
          )}

         
        </div>
      </div>
    </div>
  );
};

export default TelegramLogin;